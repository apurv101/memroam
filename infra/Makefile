PROFILE ?= operator
REGION  ?= us-west-2
PREFIX  ?= memory-vault
SECRET  := $(PREFIX)/github-app

ZIP := $(abspath build/server.zip)

.PHONY: init ensure-secret package plan deploy destroy output

init:
	terraform init

# Zip the hosted server (zero deps — plain ESM files, no build step).
package:
	rm -rf build/stage $(ZIP) && mkdir -p build/stage/src/hosted
	cp ../index.mjs build/stage/
	cp ../src/store.mjs ../src/instructions.mjs ../src/dispatch.mjs build/stage/src/
	cp ../src/hosted/*.mjs build/stage/src/hosted/
	cd build/stage && zip -qXr $(ZIP) .

# Secrets live outside Terraform: create with placeholders only if missing,
# so destroy/rebuild cycles never touch real credentials.
ensure-secret:
	@aws secretsmanager describe-secret --secret-id $(SECRET) \
		--profile $(PROFILE) --region $(REGION) >/dev/null 2>&1 \
	&& echo "secret $(SECRET) exists — skipping" \
	|| aws secretsmanager create-secret --name $(SECRET) \
		--description "GitHub App credentials for the memory-vault hosted tier" \
		--secret-string '{"app_id":"REPLACE_ME","client_id":"REPLACE_ME","client_secret":"REPLACE_ME","slug":"REPLACE_ME","private_key":"REPLACE_ME"}' \
		--profile $(PROFILE) --region $(REGION)

plan: init ensure-secret package
	TF_VAR_package_zip=$(ZIP) terraform plan

deploy: init ensure-secret package
	TF_VAR_package_zip=$(ZIP) terraform apply

# Leaves the secret in place by design.
destroy:
	terraform destroy

output:
	terraform output
