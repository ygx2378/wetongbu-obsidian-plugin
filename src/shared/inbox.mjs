import crypto from "node:crypto";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

function normalizePrefix(value) {
  return (value || "WeTongbu").replace(/^\/+|\/+$/g, "");
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function getObjectBuffer(client, bucket, key) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error(`R2 object has no body: ${key}`);
  return Buffer.from(await response.Body.transformToByteArray());
}

function verifyObject(body, expected, label) {
  if (body.length !== expected.bytes) {
    throw new Error(`${label} size mismatch`);
  }
  if (sha256(body) !== expected.sha256) {
    throw new Error(`${label} SHA-256 mismatch`);
  }
}

export async function listReadyManifestKeys(
  client,
  bucket,
  prefix = "WeTongbu",
) {
  const inboxPrefix = `${normalizePrefix(prefix)}/inbox/`;
  const keys = [];
  let continuationToken;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: inboxPrefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key?.endsWith("/manifest.json")) keys.push(object.Key);
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return keys.sort();
}

export async function downloadReadyTask(client, bucket, manifestKey) {
  if (!manifestKey.endsWith("/manifest.json")) {
    throw new Error("Invalid manifest key");
  }
  const manifestBody = await getObjectBuffer(client, bucket, manifestKey);
  const manifest = JSON.parse(manifestBody.toString("utf8"));
  if (manifest.protocolVersion !== 1 || !manifest.taskId) {
    throw new Error("Unsupported inbox manifest");
  }

  const markdownBody = await getObjectBuffer(
    client,
    bucket,
    manifest.markdown.key,
  );
  verifyObject(markdownBody, manifest.markdown, "Markdown");

  const assets = [];
  for (const asset of manifest.assets ?? []) {
    const body = await getObjectBuffer(client, bucket, asset.key);
    verifyObject(body, asset, asset.relativePath);
    assets.push({ ...asset, body });
  }

  return {
    manifestKey,
    manifest,
    markdown: markdownBody.toString("utf8"),
    assets,
  };
}

export async function deleteReadyTask(client, bucket, task) {
  const keys = [
    task.manifestKey,
    task.manifest.markdown.key,
    ...(task.manifest.assets ?? []).map((asset) => asset.key),
  ];
  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  return keys.length;
}

