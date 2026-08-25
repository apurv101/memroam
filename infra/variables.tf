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

# Path to the built server zip. Null = deploy the inline placeholder
# handler, so `terraform apply` works before the real server exists.
variable "package_zip" {
  description = "Path to the Lambda deployment zip"
  type        = string
}
