export class CanopyApiError extends Error {
    status;
    body;
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
        this.name = "CanopyApiError";
    }
}
export class CanopyApiClient {
    apiKey;
    baseUrl;
    constructor(apiKey, baseUrl = process.env.CANOPY_BASE_URL ??
        "https://trycanopy.ai") {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
    }
    headers() {
        return {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
        };
    }
    async request(method, path, body) {
        let res;
        try {
            res = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers: this.headers(),
                body: body != null ? JSON.stringify(body) : undefined,
            });
        }
        catch (err) {
            throw new CanopyApiError(`Network error reaching ${this.baseUrl}${path}: ${err instanceof Error ? err.message : String(err)}`, 0);
        }
        let parsed;
        try {
            parsed = await res.json();
        }
        catch {
            parsed = undefined;
        }
        if (!res.ok) {
            const message = parsed?.error ??
                `${method} ${path} failed with ${res.status}`;
            throw new CanopyApiError(message, res.status, parsed);
        }
        return parsed;
    }
    async me() {
        return this.request("GET", "/api/me");
    }
    async createPolicy(policy) {
        // Allowlist intentionally omitted — users configure allowlisted services in
        // the Canopy dashboard so they can browse the live registry. The CLI
        // creates the policy with no allowlist (open to any service).
        return this.request("POST", "/api/policies", {
            name: policy.name,
            description: policy.description,
            spend_cap_usd: policy.spend_cap_usd,
            cap_period_hours: policy.cap_period_hours,
            approval_required: policy.approval_required,
            approval_threshold_usd: policy.approval_threshold_usd,
        });
    }
    async createAgent(name, policyId) {
        return this.request("POST", "/api/agents", {
            name,
            policyId,
        });
    }
}
