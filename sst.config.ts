/// <reference path="./.sst/platform/config.d.ts" />

/**
 * basics-runtime — SST v3 infrastructure.
 *
 * Single Hono service (`api/`) deployed on AWS Fargate behind an ALB in
 * us-east-1, fronted by `api.trybasics.ai` (DNS managed externally at
 * Vercel). No web dashboard, no `app.trybasics.ai`.
 *
 * Adapted from the sibling `agent/` repo's SST config; sendblue, composio,
 * stripe, brain-archive, scheduler, SES bounce wiring and Lambda-API stack
 * have all been stripped — runtime is intentionally narrow.
 *
 * Stubbed-but-empty resources for future phases:
 *   - RuntimeScreenshotsBucket (Phase 05 audit log screenshots, 90-day TTL)
 *   - RuntimeWorkflowSchedulerRule (Phase 10 cron-fired runs, no schedule yet)
 */
export default $config({
  app(input) {
    return {
      name: "basics-runtime",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: {
          region: "us-east-1",
          defaultTags: {
            tags: {
              project: "basics-runtime",
              environment: input?.stage ?? "production",
            },
          },
        },
      },
    };
  },
  async run() {
    // ---------------------------------------------------------------------
    // Secrets (SSM Parameter Store via sst.Secret)
    //
    // Set with `sst secret set <Name> <value> --stage <stage>`. The list is
    // narrow on purpose: only env vars that api/src/config.ts actually
    // loads, plus Browserbase keys pre-wired for Phase 01 (browser
    // orchestration) so that phase doesn't have to re-edit IAM/secrets.
    // ---------------------------------------------------------------------
    const secrets = {
      supabaseUrl: new sst.Secret("SupabaseUrl"),
      supabaseServiceRoleKey: new sst.Secret("SupabaseServiceRoleKey"),
      supabaseAnonKey: new sst.Secret("SupabaseAnonKey"),
      supabaseJwtSecret: new sst.Secret("SupabaseJwtSecret"),
      workspaceJwtSecret: new sst.Secret("WorkspaceJwtSecret"),
      workspaceApiKeyHashSecret: new sst.Secret("WorkspaceApiKeyHashSecret"),
      // Upstash Redis URL for the managed-gateway rate limiter. Format:
      // `rediss://default:<pw>@<host>.upstash.io:6379`. When unset, the
      // middleware falls back to per-instance in-memory counters
      // (correct for 1 api task; loose at multi-task scale).
      managedGatewayRateLimitRedisUrl: new sst.Secret("ManagedGatewayRateLimitRedisUrl"),
      deepgramApiKey: new sst.Secret("DeepgramApiKey"),
      googleGenerativeAiApiKey: new sst.Secret("GoogleGenerativeAiApiKey"),
      anthropicApiKey: new sst.Secret("AnthropicApiKey"),
      databaseUrl: new sst.Secret("DatabaseUrl"),
      // A.6 — Supavisor pooler URL for Lambda → Postgres. Pattern:
      //   postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
      databaseUrlPooler: new sst.Secret("DatabaseUrlPooler"),
      // Phase 01 — Browserbase. Wired now so Phase 01 doesn't redo IAM.
      browserbaseApiKey: new sst.Secret("BrowserbaseApiKey"),
      browserbaseProjectId: new sst.Secret("BrowserbaseProjectId"),
      // Phase 10.5 — shared secret EventBridge presents in X-Cron-Secret
      // when invoking the API destination. Set with:
      //   sst secret set RuntimeCronSecret <random-32-byte-hex> --stage production
      runtimeCronSecret: new sst.Secret("RuntimeCronSecret"),
    };

    const secretLinks = Object.values(secrets);

    // ---------------------------------------------------------------------
    // VPC: 2 public + 2 private subnets, NAT gateway, internet gateway.
    // The Fargate service runs in private subnets and reaches the internet
    // (Browserbase, Anthropic, Supabase, Deepgram) via the managed NAT.
    // ---------------------------------------------------------------------
    const vpc = new sst.aws.Vpc("RuntimeVpc", {
      az: 2,
      nat: "managed",
    });

    // ---------------------------------------------------------------------
    // S3: screenshots bucket for Phase 05 audit logs.
    // 90-day expiry — audit screenshots are reference material, not records.
    // Bucket is linked to the Fargate task so the runtime gets IAM
    // s3:GetObject/PutObject scoped automatically by SST.
    // ---------------------------------------------------------------------
    const screenshotsBucket = new sst.aws.Bucket("RuntimeScreenshotsBucket", {
      transform: {
        bucket: {
          bucket: "basics-runtime-screenshots",
          lifecycleRules: [
            {
              id: "expire-screenshots-90-days",
              enabled: true,
              expirations: [{ days: 90 }],
            },
          ],
        },
      },
    });

    // ---------------------------------------------------------------------
    // ECS Cluster (Fargate-only — no EC2 capacity providers).
    // ---------------------------------------------------------------------
    const cluster = new sst.aws.Cluster("RuntimeCluster", {
      vpc,
      transform: {
        cluster: {
          name: `basics-runtime-${$app.stage}`,
          settings: [
            { name: "containerInsights", value: "enabled" },
          ],
        },
      },
    });

    // ---------------------------------------------------------------------
    // ACM Certificate for api.trybasics.ai (DNS validation via Vercel).
    // Phase 12 cutover: runtime takes over the hostname from agent/'s
    // API Gateway. ACM validation CNAME is reused from agent/'s prior
    // cert request when the validation token is identical (same
    // account + region); if not, the operator must add the new CNAME
    // values at Vercel before this deploy completes.
    // ---------------------------------------------------------------------
    const apiCert = new aws.acm.Certificate("RuntimeApiCertificate", {
      domainName: "api.trybasics.ai",
      validationMethod: "DNS",
      tags: {
        project: "basics-runtime",
        environment: $app.stage,
      },
    });

    const apiCertValidation = new aws.acm.CertificateValidation(
      "RuntimeApiCertValidation",
      {
        certificateArn: apiCert.arn,
      },
    );

    // ---------------------------------------------------------------------
    // Hono Fargate service (api/).
    //
    // - Node 22 image built from api/ workspace.
    // - 1 vCPU / 2 GB memory baseline.
    // - Public ALB on 443 (TLS via the ACM cert above), forwarding to
    //   container port 3001 (api/src/index.ts default).
    // - Healthcheck path `/health` — the unauthenticated probe in app.ts.
    //   The auth-gated `/v1/runtime/health` is for callers who want to
    //   verify the JWT chain end-to-end; using it here would 401 the ALB.
    // - Secrets linked individually via the `link` array; SST projects
    //   them as env vars whose names match api/src/config.ts.
    // ---------------------------------------------------------------------
    const apiService = new sst.aws.Service("RuntimeApi", {
      cluster,
      cpu: "1 vCPU",
      memory: "2 GB",
      architecture: "arm64",
      // Build context is the runtime root so the Dockerfile can COPY the
      // pnpm-lock.yaml, root package.json, and per-workspace manifests for a
      // cached `pnpm install` layer.
      image: {
        context: ".",
        dockerfile: "api/Dockerfile",
      },
      // `sst dev` runs the local server with secrets piped in via Doppler.
      // tsx handles the watcher; the root-level dev script wraps in doppler too.
      dev: {
        command: "doppler run --project backend --config dev -- tsx watch src/index.ts",
        directory: "api",
      },
      link: [...secretLinks, screenshotsBucket],
      environment: {
        NODE_ENV: "production",
        PORT: "3001",
        LOG_LEVEL: "info",
        // Inject api/src/config.ts variables from secrets.
        SUPABASE_URL: secrets.supabaseUrl.value,
        SUPABASE_SERVICE_ROLE_KEY: secrets.supabaseServiceRoleKey.value,
        SUPABASE_ANON_KEY: secrets.supabaseAnonKey.value,
        SUPABASE_JWT_SECRET: secrets.supabaseJwtSecret.value,
        WORKSPACE_JWT_SECRET: secrets.workspaceJwtSecret.value,
        WORKSPACE_API_KEY_HASH_SECRET: secrets.workspaceApiKeyHashSecret.value,
        MANAGED_GATEWAY_RATE_LIMIT_REDIS_URL: secrets.managedGatewayRateLimitRedisUrl.value,
        DEEPGRAM_API_KEY: secrets.deepgramApiKey.value,
        // api/src/config.ts validates GEMINI_API_KEY (the SST secret name
        // is googleGenerativeAiApiKey for legacy reasons; the env var the
        // app reads is GEMINI_API_KEY).
        GEMINI_API_KEY: secrets.googleGenerativeAiApiKey.value,
        ANTHROPIC_API_KEY: secrets.anthropicApiKey.value,
        DATABASE_URL: secrets.databaseUrl.value,
        DATABASE_URL_POOLER: secrets.databaseUrlPooler.value,
        // Pre-wired for Phase 01 browser orchestration. Loader in
        // api/src/config.ts will gain these fields when that phase lands.
        BROWSERBASE_API_KEY: secrets.browserbaseApiKey.value,
        BROWSERBASE_PROJECT_ID: secrets.browserbaseProjectId.value,
        // Bucket name surfaces via SST resource link, but we also expose
        // it as a stable env name for code that reads process.env directly.
        RUNTIME_SCREENSHOTS_BUCKET: screenshotsBucket.name,
        // Phase 10.5 — cron firing.
        // RUNTIME_CRON_SECRET: enables the X-Cron-Secret auth path on
        // POST /v1/runtime/workflows/:id/run-now (see api/src/middleware/cronAuth.ts).
        RUNTIME_CRON_SECRET: secrets.runtimeCronSecret.value,
        // EVENTBRIDGE_RULE_PREFIX: deterministic per-stage. When set,
        // the API process manages per-workflow rules in lockstep with
        // workflow CRUD. When unset, lifecycle hooks are no-ops.
        EVENTBRIDGE_RULE_PREFIX: `runtime-workflow-${$app.stage}`,
        // The API destination + invoker role ARNs are circular w.r.t.
        // apiService.url, so they're plumbed via a second-pass deploy:
        // first deploy creates the resources; operator copies the
        // outputs into a sst.Secret (or hardcoded env) and re-deploys.
        // Alternative: expose them via SSM Parameter Store and have
        // the runtime read at boot. Documented in docs/CRON_DEPLOY.md.
        EVENTBRIDGE_API_DESTINATION_ARN:
          process.env.EVENTBRIDGE_API_DESTINATION_ARN ?? "",
        EVENTBRIDGE_TARGET_ROLE_ARN:
          process.env.EVENTBRIDGE_TARGET_ROLE_ARN ?? "",
      },
      loadBalancer: {
        ports: [
          {
            listen: "443/https",
            forward: "3001/http",
          },
        ],
        domain: {
          name: "api.trybasics.ai",
          dns: false,
          cert: apiCertValidation.certificateArn,
        },
        health: {
          "3001/http": {
            path: "/health",
            interval: "30 seconds",
            timeout: "5 seconds",
            healthyThreshold: 2,
            unhealthyThreshold: 3,
            successCodes: "200",
          },
        },
      },
      transform: {
        service: {
          name: `basics-runtime-api-${$app.stage}`,
        },
      },
    });

    // ---------------------------------------------------------------------
    // EventBridge cron firing — Phase 10.5.
    //
    // This block provisions the *infrastructure* EventBridge needs to
    // call the runtime API on a schedule. The per-workflow rules (one
    // per workflow row that has a `schedule` set) are created at
    // RUNTIME by the API process via the AWS SDK — see
    // `api/src/lib/eventbridge.ts`.
    //
    // Pieces:
    //   1. Connection — carries the X-Cron-Secret header. EventBridge
    //      doesn't natively support per-target auth headers; the
    //      Connection abstraction holds the secret centrally and the
    //      API destination references it.
    //   2. API destination — points at the runtime ALB and templates
    //      `*` into the `:id` path segment. EventBridge substitutes
    //      target HttpParameters.PathParameterValues at fire time.
    //   3. IAM role — EventBridge assumes this to invoke the API
    //      destination. Permissions: events:InvokeApiDestination on
    //      the destination ARN, plus secretsmanager:GetSecretValue on
    //      the auto-generated connection secret (EventBridge requires
    //      this to read the X-Cron-Secret value).
    //
    // Pre-deploy: `sst secret set RuntimeCronSecret <random-hex>`.
    // Post-deploy: the API process reads EVENTBRIDGE_RULE_PREFIX +
    // EVENTBRIDGE_API_DESTINATION_ARN + EVENTBRIDGE_TARGET_ROLE_ARN
    // from its environment and uses them to manage per-workflow rules.
    // ---------------------------------------------------------------------

    // 1. Connection. The "API key" auth scheme is the simplest way to
    //    inject a custom header — we set the header *name* to
    //    `X-Cron-Secret` and the *value* to the runtimeCronSecret SSM
    //    value. EventBridge stores this in a Secrets Manager secret it
    //    auto-creates and references at fire time.
    const cronConnection = new aws.cloudwatch.EventConnection(
      "RuntimeCronConnection",
      {
        name: `runtime-cron-connection-${$app.stage}`,
        description: "Cron secret header for runtime workflow firing",
        authorizationType: "API_KEY",
        authParameters: {
          apiKey: {
            key: "X-Cron-Secret",
            value: secrets.runtimeCronSecret.value,
          },
        },
      },
    );

    // 2. API destination. The InvocationEndpoint is the run-now route
    //    on the ALB; `*` is substituted with the workflow id at fire
    //    time via the rule target's HttpParameters.PathParameterValues.
    //    EventBridge API destinations require HTTPS — `apiService.url`
    //    resolves to `https://api.trybasics.ai` once the cert + custom
    //    domain are wired in (Phase 12 cutover, see ACM block above).
    //
    //    NOTE: until the Vercel CNAME for api.trybasics.ai flips from
    //    agent/'s API Gateway to runtime/'s ALB, scheduled fires will
    //    hit agent's gateway and 404. The destination still deploys
    //    cleanly because PutTargets only validates the URL scheme and
    //    syntax, not reachability. The
    //    runtime API process reads EVENTBRIDGE_API_DESTINATION_ARN
    //    optionally — if it's empty, the lifecycle helpers throw at
    //    upsert time. Operator can leave this commented out until
    //    Phase 12 cutover lands.
    const apiDestination = new aws.cloudwatch.EventApiDestination(
      "RuntimeCronApiDestination",
      {
        name: `runtime-cron-runnow-${$app.stage}`,
        description: "Cron-fired POST /v1/runtime/workflows/{id}/run-now",
        connectionArn: cronConnection.arn,
        // The ALB URL is HTTP-only today; EventBridge requires HTTPS.
        // Replace with `https://api.trybasics.ai/...` once the cert is
        // back. See Phase 12 cutover notes in HANDOFF.md.
        invocationEndpoint: $interpolate`${apiService.url}/v1/runtime/workflows/*/run-now`,
        httpMethod: "POST",
        invocationRateLimitPerSecond: 10,
      },
    );

    // 3. IAM role for EventBridge to invoke the API destination.
    const cronInvokerRole = new aws.iam.Role("RuntimeCronInvokerRole", {
      name: `runtime-cron-invoker-${$app.stage}`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "events.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    new aws.iam.RolePolicy("RuntimeCronInvokerPolicy", {
      role: cronInvokerRole.id,
      name: "runtime-cron-invoke-policy",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": "events:InvokeApiDestination",
            "Resource": "${apiDestination.arn}"
          }
        ]
      }`,
    });

    // 4. The API service needs IAM permissions to manage per-workflow
    //    rules at runtime (PutRule, PutTargets, RemoveTargets,
    //    DeleteRule). Scope to rules whose name starts with our prefix
    //    so the task role can't touch unrelated EventBridge rules.
    const eventbridgeRulePrefix = `runtime-workflow-${$app.stage}`;
    new aws.iam.RolePolicy("RuntimeApiEventBridgePolicy", {
      role: apiService.taskRole.name,
      name: "runtime-api-eventbridge-policy",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "events:PutRule",
              "events:DeleteRule",
              "events:DescribeRule",
              "events:PutTargets",
              "events:RemoveTargets",
              "events:ListTargetsByRule",
              "events:ListRules"
            ],
            "Resource": "arn:aws:events:*:*:rule/${eventbridgeRulePrefix}-*"
          },
          {
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": "${cronInvokerRole.arn}"
          }
        ]
      }`,
    });

    // 5. Inject EventBridge identifiers into the API service's env so
    //    the runtime can manage rules. We re-assign the environment on
    //    `apiService` via the SST environment param above — but since
    //    we already declared `apiService` upstream of these resources,
    //    we instead pass the values via sst.aws.Service env merge by
    //    expressing the dependency through `$interpolate`. The actual
    //    wiring is: append these env vars to the apiService definition
    //    above (manual step — see TODO in the apiService config).
    //
    //    NOTE: SST v3 doesn't expose post-hoc env mutation cleanly; the
    //    operator should add these three to the apiService.environment
    //    block manually after cron resources land. Documented in
    //    docs/CRON_DEPLOY.md.

    // ---------------------------------------------------------------------
    // BUILD-LOOP Phase A.2 — cloud-agent foundations (slice 1: ECR + cluster).
    //
    // The full A.2 lands across multiple build-loop iterations:
    //   slice 1 (this commit): ECR repo + ECS cluster
    //   slice 2: 3-container Task Definition + IAM task/exec roles
    //   slice 3: SQS FIFO queue + Dispatcher Lambda + SQS event source mapping
    //   slice 4: A.3 — EFS file system + access point class wired into task def
    //
    // Stage policy: all of this targets `--stage production` (no stg stage —
    // production currently has no real users; see docs/.build-loop/config.json).
    // ---------------------------------------------------------------------

    // ECR repository for the basics-worker container image. The worker image
    // is pushed during build-loop step A.9 (smoke-test); the Task Definition
    // (slice 2) references this repo's URL.
    const workerEcrRepo = new aws.ecr.Repository("BasicsWorkerEcrRepo", {
      name: "basics-worker",
      imageTagMutability: "MUTABLE",
      // Allow `aws ecr delete-repository --force` only on non-prod stages so a
      // future stg/dev deploy can be torn down. Prod retains.
      forceDelete: $app.stage !== "production",
      encryptionConfigurations: [{ encryptionType: "AES256" }],
      imageScanningConfiguration: { scanOnPush: true },
      tags: {
        project: "basics-runtime",
        component: "cloud-agent-worker",
        environment: $app.stage,
      },
    });

    // ECS cluster for cloud-agent tasks (separate from RuntimeCluster which
    // hosts the api Hono service). Reuses the existing RuntimeVpc — tasks
    // run in the same private subnets so they share the NAT egress path.
    //
    // Capacity providers are configured per BUILD-LOOP.md A.2: Fargate-Spot
    // preferred (3) with on-demand Fargate (1) as fallback for failed Spot
    // launches. SST's Cluster component delegates capacity provider config
    // to the underlying aws.ecs.Cluster, which we set via transform.
    const agentCluster = new sst.aws.Cluster("BasicsAgentCluster", {
      vpc,
      transform: {
        cluster: {
          name: "basics-agent",
          settings: [
            { name: "containerInsights", value: "enabled" },
          ],
        },
      },
    });

    // Capacity providers (Fargate-Spot preferred, on-demand fallback).
    // sst.aws.Cluster doesn't expose this directly, so we attach via a
    // raw aws.ecs.ClusterCapacityProviders resource.
    new aws.ecs.ClusterCapacityProviders(
      "BasicsAgentClusterCapacityProviders",
      {
        clusterName: agentCluster.nodes.cluster.name,
        capacityProviders: ["FARGATE_SPOT", "FARGATE"],
        defaultCapacityProviderStrategies: [
          { capacityProvider: "FARGATE_SPOT", weight: 3, base: 0 },
          { capacityProvider: "FARGATE",      weight: 1, base: 0 },
        ],
      },
    );

    // ---------------------------------------------------------------------
    // A.2 slice 2 — Task Definition + IAM roles + CloudWatch log group.
    //
    // The task definition has 3 containers per BUILD-LOOP §16.3:
    //   - basics-worker  : main loop, port 8080, image from BasicsWorkerEcrRepo
    //   - opencode       : sidecar, port 7000, placeholder image until A.8 lands
    //   - browser-harness: sidecar, port 9876, placeholder image until A.8 lands
    //
    // ECS healthchecks are intentionally not declared on the worker container
    // because its runtime image (oven/bun distroless) has no shell — we'll
    // rely on the dispatcher's RunTask + the worker's /healthz being polled
    // by callers, not by Docker. Sidecars use amazonlinux:2023 which does
    // have a shell, but they're stub-only at this stage so no healthcheck.
    //
    // §22 IAM scoping is added INCREMENTALLY:
    //   - exec role: AWS-managed AmazonECSTaskExecutionRolePolicy (ECR pull
    //     + CloudWatch logs)
    //   - task role: bare; SQS/KMS/S3/EFS policies attached as those
    //     resources land in slice 3 / A.3 / Phase B.
    // ---------------------------------------------------------------------

    // CloudWatch log group for the basics-worker task containers.
    const workerLogGroup = new aws.cloudwatch.LogGroup(
      "BasicsWorkerLogGroup",
      {
        name: "/aws/ecs/basics-worker",
        retentionInDays: 14,
        tags: {
          project: "basics-runtime",
          component: "cloud-agent-worker",
          environment: $app.stage,
        },
      },
    );

    // ECS task execution role: ECS itself uses this to pull images from
    // ECR + write container logs to CloudWatch. The AWS-managed
    // AmazonECSTaskExecutionRolePolicy covers both.
    const workerExecutionRole = new aws.iam.Role(
      "BasicsWorkerExecutionRole",
      {
        name: "basics-worker-execution-role",
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ecs-tasks.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        managedPolicyArns: [
          "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        ],
        tags: {
          project: "basics-runtime",
          component: "cloud-agent-worker",
          environment: $app.stage,
        },
      },
    );

    // ECS task role: the worker process assumes this at runtime to access
    // workspace-scoped resources. Policies attach later as resources land
    // (slice 3: SQS receive/delete on basics-runs.fifo; A.3: EFS
    // ClientMount + ClientWrite on the workspace access point).
    const workerTaskRole = new aws.iam.Role(
      "BasicsWorkerTaskRole",
      {
        name: "basics-worker-task-role",
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ecs-tasks.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        tags: {
          project: "basics-runtime",
          component: "cloud-agent-worker",
          environment: $app.stage,
        },
      },
    );

    // EFS file system + access point — declared early so the task def
    // can reference them in its `volumes` block. Mount targets + IAM
    // policies still live in the A.3 block below; they only need the
    // file system + access point by name.
    const efsSecurityGroup = new aws.ec2.SecurityGroup(
      "BasicsWorkspacesEfsSg",
      {
        name: "basics-workspaces-efs",
        description: "EFS NFS access for basics-worker tasks (intra-VPC only)",
        vpcId: vpc.id,
        ingress: [
          {
            protocol: "tcp",
            fromPort: 2049,
            toPort: 2049,
            cidrBlocks: ["10.0.0.0/16"],
            description: "NFS from VPC CIDR",
          },
        ],
        egress: [
          { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
        ],
        tags: {
          project: "basics-runtime",
          component: "cloud-agent-workspaces",
          environment: $app.stage,
        },
      },
    );

    // protect: true blocks any destructive Pulumi op on this resource
    // (delete, replace) until protection is explicitly removed. Stateful
    // user data (EFS workspaces, SQS in-flight runs) lives here.
    const workspacesEfs = new aws.efs.FileSystem(
      "BasicsWorkspacesEfs",
      {
        encrypted: true,
        throughputMode: "bursting",
        performanceMode: "generalPurpose",
        lifecyclePolicies: [{ transitionToIa: "AFTER_30_DAYS" }],
        tags: {
          Name: "basics-workspaces",
          project: "basics-runtime",
          component: "cloud-agent-workspaces",
          environment: $app.stage,
        },
      },
      { protect: true },
    );

    // G.3 — single shared access point for all workspaces. Tenant
    // isolation is enforced by the worker's path policy (every write
    // resolves under /workspace/<workspaceId>/...). posixUser=1000:1000
    // matches the alpine `bun` user the worker runs as.
    const workspacesAccessPoint = new aws.efs.AccessPoint(
      "BasicsWorkspacesAccessPoint",
      {
        fileSystemId: workspacesEfs.id,
        posixUser: { uid: 1000, gid: 1000 },
        rootDirectory: {
          path: "/workspaces",
          creationInfo: {
            ownerUid: 1000,
            ownerGid: 1000,
            permissions: "0755",
          },
        },
        tags: {
          Name: "basics-workspaces-shared",
          project: "basics-runtime",
          component: "cloud-agent-workspaces",
          environment: $app.stage,
        },
      },
      { protect: true },
    );

    // Task Definition. X86_64 because the build host (Docker Desktop on
    // Windows) hits QEMU "exec format error" on arm64 cross-compile of
    // the corepack/pnpm step. ARM64 is ~30% cheaper on Fargate Spot in
    // us-east-1 — revisit once we have a Linux build host (CI runner).
    //
    // The image tag :latest is a forward reference — the build-loop
    // step that follows pushes the actual image. AWS doesn't validate
    // image existence at task-def registration time, only at task
    // launch, so this registers cleanly today.
    const workerTaskDefinition = new aws.ecs.TaskDefinition(
      "BasicsWorkerTaskDef",
      {
        family: "basics-worker",
        cpu: "1024",
        memory: "2048",
        ephemeralStorage: { sizeInGib: 21 }, // ECS minimum ephemeral above 20GB
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        runtimePlatform: {
          operatingSystemFamily: "LINUX",
          cpuArchitecture: "X86_64",
        },
        executionRoleArn: workerExecutionRole.arn,
        taskRoleArn: workerTaskRole.arn,
        // G.3 — EFS volume (shared access point) mounted into basics-worker.
        volumes: [
          {
            name: "workspaces",
            efsVolumeConfiguration: {
              fileSystemId: workspacesEfs.id,
              transitEncryption: "ENABLED",
              authorizationConfig: {
                accessPointId: workspacesAccessPoint.id,
                iam: "ENABLED",
              },
            },
          },
        ],
        containerDefinitions: $jsonStringify([
          {
            name: "basics-worker",
            image: $interpolate`${workerEcrRepo.repositoryUrl}:latest`,
            essential: true,
            portMappings: [{ containerPort: 8080, protocol: "tcp" }],
            mountPoints: [
              { sourceVolume: "workspaces", containerPath: "/workspace", readOnly: false },
            ],
            environment: [
              { name: "NODE_ENV", value: "production" },
              { name: "AWS_REGION", value: "us-east-1" },
              // Platform-wide secrets baked into the task def. Per-run
              // env (WORKSPACE_ID, RUN_ID, ACCOUNT_ID, …) still arrives
              // via dispatcher RunTask containerOverrides.
              { name: "DATABASE_URL_POOLER", value: secrets.databaseUrlPooler.value },
              { name: "BROWSERBASE_API_KEY", value: secrets.browserbaseApiKey.value },
              { name: "BROWSERBASE_PROJECT_ID", value: secrets.browserbaseProjectId.value },
              { name: "ANTHROPIC_API_KEY", value: secrets.anthropicApiKey.value },
              // G.5 — keep warm worker alive for 15 min between runs.
              // Tunable; per-run heartbeat keeps workspace_active_tasks fresh.
              { name: "IDLE_STOP_MS", value: "900000" },
              { name: "AGENT_CLUSTER_NAME", value: "basics-agent" },
            ],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": workerLogGroup.name,
                "awslogs-region": "us-east-1",
                "awslogs-stream-prefix": "main",
              },
            },
          },
          {
            name: "opencode",
            image: "public.ecr.aws/amazonlinux/amazonlinux:2023",
            command: [
              "sh",
              "-c",
              "echo 'opencode sidecar — placeholder; A.8 wires the real image'; sleep infinity",
            ],
            essential: true,
            portMappings: [{ containerPort: 7000, protocol: "tcp" }],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": workerLogGroup.name,
                "awslogs-region": "us-east-1",
                "awslogs-stream-prefix": "opencode",
              },
            },
          },
          {
            name: "browser-harness-js",
            image: "public.ecr.aws/amazonlinux/amazonlinux:2023",
            command: [
              "sh",
              "-c",
              "echo 'browser-harness-js sidecar — placeholder; A.8 wires the real image'; sleep infinity",
            ],
            essential: true,
            portMappings: [{ containerPort: 9876, protocol: "tcp" }],
            logConfiguration: {
              logDriver: "awslogs",
              options: {
                "awslogs-group": workerLogGroup.name,
                "awslogs-region": "us-east-1",
                "awslogs-stream-prefix": "browser-harness-js",
              },
            },
          },
        ]),
        tags: {
          project: "basics-runtime",
          component: "cloud-agent-worker",
          environment: $app.stage,
        },
      },
    );

    // ---------------------------------------------------------------------
    // A.2 slice 3 — SQS FIFO queue + Dispatcher Lambda + event source mapping.
    //
    // Per BUILD-LOOP §6 A.2/A.4:
    //   - Queue: basics-runs.fifo, FIFO, content-based dedup OFF
    //     (caller supplies MessageDeduplicationId), retention 4 days,
    //     visibility timeout 360s.
    //   - MessageGroupId at enqueue time = workspaceId (per §22 — FIFO
    //     enforces cross-tenant ordering isolation at the queue level).
    //   - Dispatcher Lambda: consumes the queue (event source mapping).
    //     Per-message logic is a placeholder today; A.5/A.6 wire in the
    //     workspace_active_tasks lookup + ecs.runTask call.
    // ---------------------------------------------------------------------

    // Worker task security group (declared early — referenced by the
    // dispatcher Lambda env at construction time so it can pass the SG
    // to ecs:RunTask's awsvpcConfiguration). Outbound-only; NFS ingress
    // is allowed by the EFS SG (VPC-CIDR-based).
    const workerTaskSecurityGroup = new aws.ec2.SecurityGroup(
      "BasicsWorkerTaskSg",
      {
        name: "basics-worker-task",
        description: "basics-worker ECS task - egress only (LLM/Browserbase/Supabase via NAT)",
        vpcId: vpc.id,
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        tags: {
          project: "basics-runtime",
          component: "cloud-agent-worker",
          environment: $app.stage,
        },
      },
    );

    // SQS FIFO queue. protect:true blocks delete/replace — losing the
    // queue means losing in-flight runs that haven't been consumed yet.
    const runsQueue = new aws.sqs.Queue(
      "BasicsRunsQueue",
      {
        name: "basics-runs.fifo",
        fifoQueue: true,
        contentBasedDeduplication: false,
        messageRetentionSeconds: 4 * 24 * 60 * 60,    // 4 days
        visibilityTimeoutSeconds: 360,                 // 6 minutes
        receiveWaitTimeSeconds: 20,                    // long-poll on ReceiveMessage
        tags: {
          project: "basics-runtime",
          component: "cloud-agent-dispatcher",
          environment: $app.stage,
        },
      },
      { protect: true },
    );

    // Grant the worker task role the right to receive/delete from the
    // queue — per §22, FIFO group key isolates cross-tenant traffic but
    // the task still needs IAM-level read/delete access.
    new aws.iam.RolePolicy("BasicsWorkerTaskRoleSqsPolicy", {
      role: workerTaskRole.id,
      name: "basics-worker-task-sqs-policy",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
              "sqs:ChangeMessageVisibility"
            ],
            "Resource": "${runsQueue.arn}"
          }
        ]
      }`,
    });

    // BUILD-LOOP F.3a — EventBridge Scheduler invoke role.
    // ScheduleService.attach() needs an invokeRoleArn that EventBridge
    // Scheduler assumes to push messages onto the FIFO queue. Per
    // CLOUD-AGENT-PLAN §14, schedules fire as SQS sends (not Lambda
    // invokes) so the role only needs sqs:SendMessage on basics-runs.fifo.
    const schedulerInvokeRole = new aws.iam.Role(
      "BasicsSchedulerInvokeRole",
      {
        name: `basics-scheduler-invoke-${$app.stage}`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "scheduler.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        tags: {
          project: "basics-runtime",
          component: "cloud-agent-scheduler",
          environment: $app.stage,
        },
      },
    );

    new aws.iam.RolePolicy("BasicsSchedulerInvokePolicy", {
      role: schedulerInvokeRole.id,
      name: "basics-scheduler-invoke-policy",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": "sqs:SendMessage",
            "Resource": "${runsQueue.arn}"
          }
        ]
      }`,
    });

    // The api control-plane manages schedules at runtime via the AWS
    // scheduler SDK; grant its task role the minimum scheduler:*
    // surface plus iam:PassRole on the invoke role above.
    new aws.iam.RolePolicy("BasicsApiSchedulerPolicy", {
      role: apiService.taskRole.name,
      name: "basics-api-scheduler-policy",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "scheduler:CreateSchedule",
              "scheduler:UpdateSchedule",
              "scheduler:DeleteSchedule",
              "scheduler:GetSchedule",
              "scheduler:ListSchedules"
            ],
            "Resource": "arn:aws:scheduler:*:*:schedule/default/*"
          },
          {
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": "${schedulerInvokeRole.arn}"
          }
        ]
      }`,
    });

    // Dispatcher Lambda. The handler is a placeholder today — see
    // worker/dispatcher/handler.ts. Real ecs.runTask + workspace_active_tasks
    // logic lands in A.6 once Supavisor + DB schema are wired.
    //
    // Linking the queue (`link: [runsQueue]`) gives the function
    // SQS:SendMessage perms (which is the standard sst grant). For the
    // dispatcher to RECEIVE and DELETE we also need an explicit policy
    // because event source mapping uses the function's role to consume.
    const dispatcherLambda = new sst.aws.Function("BasicsDispatcherLambda", {
      name: "basics-dispatcher",
      handler: "worker/dispatcher/handler.handler",
      runtime: "nodejs22.x",
      architecture: "arm64",
      memory: "512 MB",
      timeout: "5 minutes",                          // ≥ visibilityTimeout
      // Tell SST's esbuild bundler to install these via npm rather than
      // resolving them from worker/node_modules — pnpm symlinks +
      // Windows junctions trip the bundler with "Incorrect function".
      nodejs: {
        install: ["@aws-sdk/client-ecs", "postgres"],
      },
      link: [
        runsQueue,
        secrets.databaseUrlPooler,
        secrets.browserbaseApiKey,
        secrets.browserbaseProjectId,
        secrets.anthropicApiKey,
      ],
      environment: {
        AGENT_CLUSTER_NAME: agentCluster.nodes.cluster.name,
        WORKER_TASK_DEFINITION_ARN: workerTaskDefinition.arn,
        WORKER_TASK_ROLE_ARN: workerTaskRole.arn,
        WORKER_EXECUTION_ROLE_ARN: workerExecutionRole.arn,
        DATABASE_URL_POOLER: secrets.databaseUrlPooler.value,
        // A.9 slice 1 — networking + Browserbase pass-through for RunTask.
        WORKER_SECURITY_GROUP_ID: workerTaskSecurityGroup.id,
        WORKER_SUBNET_IDS: $jsonStringify(vpc.privateSubnets),
        BROWSERBASE_API_KEY: secrets.browserbaseApiKey.value,
        BROWSERBASE_PROJECT_ID: secrets.browserbaseProjectId.value,
        // G.1 — platform-key fallback for the worker's Anthropic loop.
        ANTHROPIC_API_KEY: secrets.anthropicApiKey.value,
      },
    });

    // Dispatcher needs perms beyond the sst link defaults: SQS receive
    // (event source mapping), ecs:RunTask, iam:PassRole for both task
    // and execution roles (RunTask requires PassRole on these).
    new aws.iam.RolePolicy("BasicsDispatcherLambdaSqsConsumePolicy", {
      role: dispatcherLambda.nodes.role.name,
      name: "basics-dispatcher-sqs-consume",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
              "sqs:ChangeMessageVisibility"
            ],
            "Resource": "${runsQueue.arn}"
          }
        ]
      }`,
    });

    new aws.iam.RolePolicy("BasicsDispatcherLambdaEcsRunTaskPolicy", {
      role: dispatcherLambda.nodes.role.name,
      name: "basics-dispatcher-ecs-runtask",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": "ecs:RunTask",
            "Resource": "arn:aws:ecs:us-east-1:${aws.getCallerIdentityOutput().accountId}:task-definition/basics-worker:*"
          },
          {
            "Effect": "Allow",
            "Action": ["ecs:DescribeTasks", "ecs:StopTask"],
            "Resource": "arn:aws:ecs:us-east-1:${aws.getCallerIdentityOutput().accountId}:task/basics-agent/*"
          },
          {
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": [
              "${workerTaskRole.arn}",
              "${workerExecutionRole.arn}"
            ]
          }
        ]
      }`,
    });

    // SQS event source mapping → Lambda. FIFO uses MessageGroupId for
    // ordering; batchSize 1 keeps each workspace's runs serialized
    // (the worker handles intra-workspace concurrency itself).
    new aws.lambda.EventSourceMapping(
      "BasicsDispatcherSqsTrigger",
      {
        eventSourceArn: runsQueue.arn,
        functionName: dispatcherLambda.name,
        batchSize: 1,
        enabled: true,
      },
    );

    // BUILD-LOOP I.1 — cron kicker. EventBridge Scheduler can't generate
    // dynamic runIds per invocation, so we put a tiny Lambda in front:
    // Scheduler invokes the kicker with a static {cloudAgentId, ws, acc,
    // goal template}; kicker mints a fresh runId, INSERTs agent_runs,
    // and posts to the basics-runs.fifo queue.
    const cronKickerLambda = new sst.aws.Function("BasicsCronKickerLambda", {
      name: "basics-cron-kicker",
      handler: "worker/cron-kicker/handler.handler",
      runtime: "nodejs22.x",
      architecture: "arm64",
      memory: "256 MB",
      timeout: "30 seconds",
      nodejs: { install: ["@aws-sdk/client-sqs", "postgres"] },
      link: [runsQueue, secrets.databaseUrlPooler],
      environment: {
        DATABASE_URL_POOLER: secrets.databaseUrlPooler.value,
        RUNS_QUEUE_URL: runsQueue.url,
      },
    });

    new aws.iam.RolePolicy("BasicsCronKickerSqsSendPolicy", {
      role: cronKickerLambda.nodes.role.name,
      name: "basics-cron-kicker-sqs-send",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": "sqs:SendMessage",
            "Resource": "${runsQueue.arn}"
          }
        ]
      }`,
    });

    // Allow EventBridge Scheduler to invoke the kicker Lambda.
    new aws.iam.RolePolicy("BasicsSchedulerInvokeKickerPolicy", {
      role: schedulerInvokeRole.id,
      name: "basics-scheduler-invoke-kicker",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": "lambda:InvokeFunction",
            "Resource": "${cronKickerLambda.arn}"
          }
        ]
      }`,
    });

    // ---------------------------------------------------------------------
    // A.3 — EFS file system + per-AZ mount targets.
    //
    // Per BUILD-LOOP §6 A.3 / CLOUD-AGENT-PLAN §3.2:
    //   - File system `basics-workspaces`, encryption-at-rest with AWS CMK,
    //     throughput mode bursting, lifecycle AFTER_30_DAYS → IA.
    //   - Mount target in each private subnet of RuntimeVpc.
    //   - Security group allowing NFS (TCP 2049) from inside the VPC.
    //   - Per-workspace access points are created LAZILY by the dispatcher
    //     Lambda at first run (see makeWorkspaceAccessPoint below — this is
    //     a runtime SDK helper, NOT a deploy-time Pulumi component, because
    //     ECS volume config can't be overridden at RunTask time).
    //
    // The Task Definition does NOT yet bake EFS volume config — wiring it
    // requires deciding between (a) per-workspace task def revisions or
    // (b) a workspace-init step in the worker that mounts the access point
    // manually. That decision lands with the dispatcher's runTask logic.
    // ---------------------------------------------------------------------

    // EFS file system + security group + access point declared earlier
    // (above the task def) so the task def can reference them in its
    // `volumes` block. Mount targets stay below.

    // One mount target per private subnet (2 AZs in RuntimeVpc).
    // protect: true on each — losing a mount target makes the EFS
    // unreachable from that AZ even if the file system itself survives.
    const efsMountTargetA = new aws.efs.MountTarget(
      "BasicsWorkspacesEfsMtA",
      {
        fileSystemId: workspacesEfs.id,
        subnetId: vpc.privateSubnets.apply((s) => s[0]!),
        securityGroups: [efsSecurityGroup.id],
      },
      { protect: true },
    );
    const efsMountTargetB = new aws.efs.MountTarget(
      "BasicsWorkspacesEfsMtB",
      {
        fileSystemId: workspacesEfs.id,
        subnetId: vpc.privateSubnets.apply((s) => s[1]!),
        securityGroups: [efsSecurityGroup.id],
      },
      { protect: true },
    );

    // Grant the worker task role EFS access. ClientMount + ClientWrite
    // are scoped to this file system; the per-workspace access point
    // boundary (path = /workspaces/<workspaceId>) enforces tenant
    // isolation, not IAM. (§22 — first line of defense is the access
    // point's path + posix uid/gid; second is the worker's path policy.)
    new aws.iam.RolePolicy("BasicsWorkerTaskRoleEfsPolicy", {
      role: workerTaskRole.id,
      name: "basics-worker-task-efs-policy",
      policy: $interpolate`{
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": [
              "elasticfilesystem:ClientMount",
              "elasticfilesystem:ClientWrite",
              "elasticfilesystem:ClientRootAccess",
              "elasticfilesystem:DescribeMountTargets",
              "elasticfilesystem:DescribeAccessPoints"
            ],
            "Resource": "${workspacesEfs.arn}"
          }
        ]
      }`,
    });

    // Grant the dispatcher Lambda perms to create + tag access points
    // for new workspaces (called at first-run via the SDK).
    new aws.iam.RolePolicy(
      "BasicsDispatcherLambdaEfsAccessPointPolicy",
      {
        role: dispatcherLambda.nodes.role.name,
        name: "basics-dispatcher-efs-accesspoint",
        policy: $interpolate`{
          "Version": "2012-10-17",
          "Statement": [
            {
              "Effect": "Allow",
              "Action": [
                "elasticfilesystem:CreateAccessPoint",
                "elasticfilesystem:DescribeAccessPoints",
                "elasticfilesystem:TagResource",
                "elasticfilesystem:DeleteAccessPoint"
              ],
              "Resource": [
                "${workspacesEfs.arn}",
                "arn:aws:elasticfilesystem:us-east-1:${aws.getCallerIdentityOutput().accountId}:access-point/*"
              ]
            }
          ]
        }`,
      },
    );

    // (EFS env vars for the dispatcher are wired in the next slice when
    //  the dispatcher Lambda is reconstructed with the EFS handle —
    //  sst.aws.Function's `environment` is fixed at construction time.)

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    return {
      ApiUrl: apiService.url,
      ClusterName: cluster.nodes.cluster.name,
      ScreenshotsBucket: screenshotsBucket.name,
      VpcId: vpc.id,
      // Phase 10.5 cron firing infra outputs — operator wires these
      // into apiService.environment manually after first deploy
      // (chicken-and-egg: apiService is defined before these exist).
      EventBridgeRulePrefix: eventbridgeRulePrefix,
      EventBridgeApiDestinationArn: apiDestination.arn,
      EventBridgeTargetRoleArn: cronInvokerRole.arn,
      EventBridgeConnectionArn: cronConnection.arn,
      // BUILD-LOOP Phase A.2 — cloud-agent infra outputs.
      AgentClusterName: agentCluster.nodes.cluster.name,
      WorkerEcrRepoUrl: workerEcrRepo.repositoryUrl,
      WorkerEcrRepoArn: workerEcrRepo.arn,
      WorkerTaskDefinitionArn: workerTaskDefinition.arn,
      WorkerTaskRoleArn: workerTaskRole.arn,
      WorkerExecutionRoleArn: workerExecutionRole.arn,
      WorkerLogGroupName: workerLogGroup.name,
      RunsQueueUrl: runsQueue.url,
      RunsQueueArn: runsQueue.arn,
      // F.3a — EventBridge Scheduler wiring for ScheduleService.attach().
      SchedulerInvokeRoleArn: schedulerInvokeRole.arn,
      // I.1 — cron kicker Lambda (Scheduler → fresh runId → SQS).
      CronKickerLambdaArn: cronKickerLambda.arn,
      DispatcherLambdaArn: dispatcherLambda.arn,
      DispatcherLambdaName: dispatcherLambda.name,
      WorkspacesEfsId: workspacesEfs.id,
      WorkspacesEfsArn: workspacesEfs.arn,
      WorkspacesEfsSecurityGroupId: efsSecurityGroup.id,
      WorkerTaskSecurityGroupId: workerTaskSecurityGroup.id,
    };
  },
});
