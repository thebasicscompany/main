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
      deepgramApiKey: new sst.Secret("DeepgramApiKey"),
      googleGenerativeAiApiKey: new sst.Secret("GoogleGenerativeAiApiKey"),
      anthropicApiKey: new sst.Secret("AnthropicApiKey"),
      databaseUrl: new sst.Secret("DatabaseUrl"),
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
        DEEPGRAM_API_KEY: secrets.deepgramApiKey.value,
        // api/src/config.ts validates GEMINI_API_KEY (the SST secret name
        // is googleGenerativeAiApiKey for legacy reasons; the env var the
        // app reads is GEMINI_API_KEY).
        GEMINI_API_KEY: secrets.googleGenerativeAiApiKey.value,
        ANTHROPIC_API_KEY: secrets.anthropicApiKey.value,
        DATABASE_URL: secrets.databaseUrl.value,
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
    };
  },
});
