// WorkspaceAccessPoint — runtime factory for per-workspace EFS access points.
// Per CLOUD-AGENT-PLAN §3.2 / BUILD-LOOP A.3: each workspace gets its own
// EFS access point bound to /workspaces/<workspaceId>/, owned by uid/gid 1000,
// mode 0750. The access point is created LAZILY by the dispatcher Lambda the
// first time a workspace runs (so we don't pay for unused workspaces and
// don't pre-allocate filesystem inodes).
//
// This is intentionally NOT a Pulumi component — ECS doesn't support volume
// config overrides at RunTask time, so per-workspace access points are not a
// build-time abstraction. The dispatcher uses this factory at first-run.

import {
  EFSClient,
  CreateAccessPointCommand,
  DescribeAccessPointsCommand,
  type AccessPointDescription,
} from "@aws-sdk/client-efs";

const client = new EFSClient({});

const POSIX_UID = 1000;
const POSIX_GID = 1000;
const ROOT_PERMISSIONS = "0750";

interface WorkspaceAccessPointOptions {
  fileSystemId: string;
  workspaceId: string;
}

interface WorkspaceAccessPointResult {
  accessPointId: string;
  accessPointArn: string;
  rootDirectory: string;
  created: boolean;
}

/**
 * Idempotent: returns the existing access point for `workspaceId` if it
 * already exists, otherwise creates a new one.
 *
 * Tag-based discovery: every access point we create is tagged with
 * `basics:workspaceId`, and we list-by-tag to dedupe.
 */
export async function ensureWorkspaceAccessPoint(
  opts: WorkspaceAccessPointOptions,
): Promise<WorkspaceAccessPointResult> {
  const { fileSystemId, workspaceId } = opts;
  const rootDirectory = `/workspaces/${workspaceId}`;

  const existing = await findExisting(fileSystemId, workspaceId);
  if (existing) {
    return {
      accessPointId: existing.AccessPointId!,
      accessPointArn: existing.AccessPointArn!,
      rootDirectory,
      created: false,
    };
  }

  const created = await client.send(
    new CreateAccessPointCommand({
      FileSystemId: fileSystemId,
      ClientToken: `basics-${workspaceId}`, // idempotency
      PosixUser: { Uid: POSIX_UID, Gid: POSIX_GID },
      RootDirectory: {
        Path: rootDirectory,
        CreationInfo: {
          OwnerUid: POSIX_UID,
          OwnerGid: POSIX_GID,
          Permissions: ROOT_PERMISSIONS,
        },
      },
      Tags: [
        { Key: "basics:workspaceId", Value: workspaceId },
        { Key: "project", Value: "basics-runtime" },
        { Key: "component", Value: "cloud-agent-workspaces" },
      ],
    }),
  );

  return {
    accessPointId: created.AccessPointId!,
    accessPointArn: created.AccessPointArn!,
    rootDirectory,
    created: true,
  };
}

async function findExisting(
  fileSystemId: string,
  workspaceId: string,
): Promise<AccessPointDescription | undefined> {
  const resp = await client.send(
    new DescribeAccessPointsCommand({ FileSystemId: fileSystemId }),
  );
  return (resp.AccessPoints ?? []).find((ap) =>
    (ap.Tags ?? []).some(
      (t) => t.Key === "basics:workspaceId" && t.Value === workspaceId,
    ),
  );
}
