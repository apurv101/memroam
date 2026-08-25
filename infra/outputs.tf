output "service_url" {
  description = "Public HTTPS URL of the service — the MCP endpoint base"
  value       = aws_lambda_function_url.server.function_url
}

output "github_app_secret_name" {
  description = "Secrets Manager secret to fill with the GitHub App credentials"
  value       = data.aws_secretsmanager_secret.github_app.name
}

output "control_plane_tables" {
  description = "DynamoDB control-plane table names"
  value = {
    users         = aws_dynamodb_table.users.name
    oauth_clients = aws_dynamodb_table.oauth_clients.name
    grants        = aws_dynamodb_table.grants.name
  }
}
