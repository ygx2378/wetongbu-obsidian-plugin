export interface FreeS3EndpointConfig {
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: boolean;
}

export function buildFreeS3BaseUrl(config: FreeS3EndpointConfig): string {
  if (!config.endpoint) return `https://${config.bucket}.s3.${config.region || "auto"}.amazonaws.com`;
  const endpoint = config.endpoint.replace(/\/$/, "");
  if (config.forcePathStyle) return `${endpoint}/${config.bucket}`;

  const url = new URL(endpoint);
  url.hostname = `${config.bucket}.${url.hostname}`;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function deriveS3Config(
  provider: string,
  endpoint: string,
  region: string,
  bucket: string,
  _prefix: string,
): { endpoint: string; region: string; forcePathStyle: boolean } {
  switch (provider) {
    case "cloudflare_r2":
      return { endpoint, region: "auto", forcePathStyle: true };
    case "aws_s3":
      return { endpoint: "", region: region || "ap-southeast-1", forcePathStyle: false };
    case "aliyun_oss": {
      const r = region || "cn-hangzhou";
      return { endpoint: `https://s3.oss-${r}.aliyuncs.com`, region: r, forcePathStyle: false };
    }
    case "tencent_cos": {
      const r = region || "ap-guangzhou";
      return { endpoint: `https://cos.${r}.myqcloud.com`, region: r, forcePathStyle: false };
    }
    default:
      return { endpoint, region, forcePathStyle: true };
  }
}
