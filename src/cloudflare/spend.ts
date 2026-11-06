import type { Usage } from "../core/spend";

const API = "https://api.cloudflare.com/client/v4";
const BYTES_IN_A_GB = 1e9;
const STORAGE_LOOKBACK_MS = 2 * 86_400_000;

// As R2's price list names them: reads of an object, and everything else that is not free.
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary"]);
const FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

// A rule made once by hand and only switched here, so the token never has to create anything.
const BLOCK_EXPRESSION = 'starts_with(http.request.uri.path, "/api/")';

export interface SpendBindings {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_RULESET_ID: string;
  CF_RULE_ID: string;
  CF_DATABASE_ID: string;
  CF_SCRIPT_NAME: string;
  CF_BUCKET_NAME: string;
}

const QUERY = `query Usage($account: string!, $script: string!, $database: string!, $bucket: string!,
  $since: Time!, $until: Time!, $sinceDate: Date!, $untilDate: Date!, $storedSince: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
      sum { requests }
    }
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $database, date_geq: $sinceDate, date_leq: $untilDate }) {
      sum { rowsRead rowsWritten }
    }
    r2: r2OperationsAdaptiveGroups(limit: 100, filter: { bucketName: $bucket, datetime_geq: $since, datetime_leq: $until }) {
      sum { requests }
      dimensions { actionType }
    }
    stored: r2StorageAdaptiveGroups(limit: 1, orderBy: [datetime_DESC], filter: { bucketName: $bucket, datetime_geq: $storedSince, datetime_leq: $until }) {
      max { payloadSize metadataSize }
      dimensions { datetime }
    }
  } }
}`;

interface Answered {
  errors?: { message: string }[] | null;
  data?: {
    viewer?: {
      accounts?: {
        workers: { sum: { requests: number } }[];
        d1: { sum: { rowsRead: number; rowsWritten: number } }[];
        r2: { sum: { requests: number }; dimensions: { actionType: string } }[];
        stored: { max: { payloadSize: number; metadataSize: number } }[];
      }[];
    };
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const dateOf = (ms: number): string => iso(ms).slice(0, 10);

export class CloudSpend {
  readonly #bindings: SpendBindings;
  readonly #fetch: typeof fetch;

  constructor(bindings: SpendBindings, fetcher: typeof fetch = fetch) {
    this.#bindings = bindings;
    this.#fetch = fetcher;
  }

  async usageSince(start: number, now: number): Promise<Usage> {
    const { CF_ACCOUNT_ID, CF_SCRIPT_NAME, CF_DATABASE_ID, CF_BUCKET_NAME } = this.#bindings;
    const response = await this.#call("/graphql", "POST", {
      query: QUERY,
      variables: {
        account: CF_ACCOUNT_ID,
        script: CF_SCRIPT_NAME,
        database: CF_DATABASE_ID,
        bucket: CF_BUCKET_NAME,
        since: iso(start),
        until: iso(now),
        sinceDate: dateOf(start),
        untilDate: dateOf(now),
        storedSince: iso(now - STORAGE_LOOKBACK_MS),
      },
    });
    const { data, errors } = (await response.json()) as Answered;
    const account = data?.viewer?.accounts?.[0];
    // A bill read wrong would block for nothing, or never block: better to fail and let the heartbeat say so.
    if ((errors && errors.length > 0) || !account) throw new Error(`no usage: ${errors?.[0]?.message ?? "no account"}`);

    const operations = account.r2.filter((one) => !FREE.has(one.dimensions.actionType));
    const countOf = (isB: boolean): number =>
      operations
        .filter((one) => CLASS_B.has(one.dimensions.actionType) === isB)
        .reduce((sum, one) => sum + one.sum.requests, 0);
    const stored = account.stored[0]?.max;
    return {
      requests: account.workers[0]?.sum.requests ?? 0,
      rowsRead: account.d1[0]?.sum.rowsRead ?? 0,
      rowsWritten: account.d1[0]?.sum.rowsWritten ?? 0,
      classA: countOf(false),
      classB: countOf(true),
      storedGb: ((stored?.payloadSize ?? 0) + (stored?.metadataSize ?? 0)) / BYTES_IN_A_GB,
    };
  }

  async setBlocked(blocked: boolean): Promise<void> {
    const { CF_ZONE_ID, CF_RULESET_ID, CF_RULE_ID } = this.#bindings;
    await this.#call(`/zones/${CF_ZONE_ID}/rulesets/${CF_RULESET_ID}/rules/${CF_RULE_ID}`, "PATCH", {
      action: "block",
      expression: BLOCK_EXPRESSION,
      description: "Folio: the spending line was reached (decision 118)",
      enabled: blocked,
    });
  }

  async #call(path: string, method: string, body: unknown): Promise<Response> {
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#bindings.CF_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Cloudflare answered ${response.status} to ${method} ${path}`);
    return response;
  }
}
