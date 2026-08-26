resource "aws_cloudwatch_log_group" "server" {
  name              = "/aws/lambda/${var.name_prefix}-server"
  retention_in_days = 14
}

resource "aws_lambda_function" "server" {
  function_name = "${var.name_prefix}-server"
  role          = aws_iam_role.lambda.arn

  filename         = var.package_zip
  source_code_hash = filebase64sha256(var.package_zip)

  runtime     = "nodejs22.x"
  handler     = "index.handler"
  memory_size = 512
  timeout     = 30

  environment {
    variables = {
      # Canonical public identity (OAuth issuer, discovery metadata). Flipped
      # from var.domain to alt_domain in the memroam rename; the old domain
      # keeps serving traffic but new OAuth flows bind to memroam.com.
      MV_PUBLIC_BASE           = "https://${var.alt_domain}"
      MV_USERS_TABLE           = aws_dynamodb_table.users.name
      MV_OAUTH_CLIENTS_TABLE   = aws_dynamodb_table.oauth_clients.name
      MV_GRANTS_TABLE          = aws_dynamodb_table.grants.name
      MV_GITHUB_APP_SECRET_ARN = data.aws_secretsmanager_secret.github_app.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.server]
}

resource "aws_lambda_function_url" "server" {
  function_name      = aws_lambda_function.server.function_name
  authorization_type = "NONE" # public HTTPS endpoint; auth is the app's OAuth layer
}

resource "aws_lambda_permission" "public_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.server.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}
