# The GitHub App secret is deliberately NOT managed by Terraform, so
# `terraform destroy` never deletes credentials and a rebuild reuses the
# existing secret. `make deploy` creates it with placeholder values only
# if it doesn't exist yet (see ensure-secret in the Makefile); fill in
# real values after creating the GitHub App:
#   aws secretsmanager put-secret-value \
#     --profile operator --region us-west-2 \
#     --secret-id memory-vault/github-app \
#     --secret-string file://github-app.json
data "aws_secretsmanager_secret" "github_app" {
  name = "${var.name_prefix}/github-app"
}
