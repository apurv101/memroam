PROFILE ?= operator
REGION  ?= us-west-2
PREFIX  ?= memory-vault
SECRET  := $(PREFIX)/github-app

.PHONY: init ensure-secret plan deploy destroy output

init:
	terraform init

# Secrets live outside Terraform: create with placeholders only if missing,
# so destroy/rebuild cycles never touch real credentials.
ensure-secret:
	@aws secretsmanager describe-secret --secret-id $(SECRET) \
		--profile $(PROFILE) --region $(REGION) >/dev/null 2>&1 \
	&& echo "secret $(SECRET) exists — skipping" \
	|| aws secretsmanager create-secret --name $(SECRET) \
		--description "GitHub App credentials for the memory-vault hosted tier" \
		--secret-string '{"app_id":"REPLACE_ME","client_id":"REPLACE_ME","client_secret":"REPLACE_ME","private_key":"REPLACE_ME"}' \
		--profile $(PROFILE) --region $(REGION)

plan: init ensure-secret
	terraform plan

deploy: init ensure-secret
	terraform apply

# Leaves the secret in place by design.
destroy:
	terraform destroy

output:
	terraform output
