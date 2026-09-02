variable "aws_profile" {
  description = "AWS CLI profile to deploy with"
  type        = string
  default     = "operator"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-west-2"
}

variable "name_prefix" {
  description = "Prefix for all resource names"
  type        = string
  default     = "memory-vault"
}

variable "domain" {
  description = "Public domain for the hosted tier (registered in Route 53)"
  type        = string
  default     = "memoryvault.click"
}

# Path to the built server zip; `make deploy`/`make plan` build it via the
# package target and pass it as TF_VAR_package_zip.
variable "package_zip" {
  description = "Path to the Lambda deployment zip"
  type        = string
}
