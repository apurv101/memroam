# infra

Terraform for the hosted tier (Phase A), deployed to AWS with the `operator` profile in `us-west-2`.

What it stands up:

- **Lambda + Function URL** — the hosted MCP server / platform, scale-to-zero (runs only per request; idle cost ~$0). Point `package_zip` at the built server zip. Cold starts (~200–500 ms) are fine — the latency budget already absorbs GitHub round-trips.
- **DynamoDB tables** (`users`, `oauth-clients`, `grants`) — control-plane bookkeeping only; memories live in each user's own GitHub repo.
- **Secrets Manager secret** (`memory-vault/github-app`) — *not* managed by Terraform: `make deploy` creates it with placeholders only if missing, and `make destroy` never deletes it, so credentials survive destroy/rebuild cycles. Fill with `aws secretsmanager put-secret-value`.
- **IAM roles** scoped to exactly those tables and that secret.

Usage:

```sh
make deploy    # terraform init + apply (asks for confirmation)
make destroy   # tears everything down (leaves the secret in place)
make output    # service URL, secret name, table names
```

State is local (`terraform.tfstate`, gitignored) — fine while this is single-operator.
