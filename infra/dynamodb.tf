# Control-plane tables: login bookkeeping, never memories.
# Memories live in the user's own GitHub repo (see the hosted-tier plan).

resource "aws_dynamodb_table" "users" {
  name         = "${var.name_prefix}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "github_id"
    type = "S"
  }

  global_secondary_index {
    name            = "by-github-id"
    hash_key        = "github_id"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "oauth_clients" {
  name         = "${var.name_prefix}-oauth-clients"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "client_id"

  attribute {
    name = "client_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "grants" {
  name         = "${var.name_prefix}-grants"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "grant_id"

  attribute {
    name = "grant_id"
    type = "S"
  }

  attribute {
    name = "user_id"
    type = "S"
  }

  global_secondary_index {
    name            = "by-user-id"
    hash_key        = "user_id"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}
