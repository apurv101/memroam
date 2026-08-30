# Custom domain: memoryvault.click → CloudFront → the Lambda Function URL.
# The Route 53 hosted zone is created by the domain registration itself and
# referenced here as data; records, cert, and distribution are all managed.
# CloudFront also restores the WWW-Authenticate header that Function URLs
# remap (x-amzn-remapped-www-authenticate), so OAuth discovery via the 401
# header works on the pretty domain.

data "aws_route53_zone" "main" {
  name = var.domain
}

resource "aws_acm_certificate" "main" {
  provider = aws.us_east_1
  # The provider models the primary domain as part of the SAN set — pin it
  # explicitly so a stale extra SAN (memroam.com) forces cert replacement.
  domain_name               = var.domain
  subject_alternative_names = [var.domain]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }
  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "main" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# Lambda Function URLs remap WWW-Authenticate, and CloudFront viewer-response
# functions don't run on 400+ responses — so the header is injected statically
# on the /mcp behavior instead. Its value is deterministic for this resource,
# which is what makes the static form correct.
resource "aws_cloudfront_response_headers_policy" "mcp_auth_header" {
  name = "${var.name_prefix}-mcp-www-authenticate"

  custom_headers_config {
    items {
      header   = "WWW-Authenticate"
      value    = "Bearer resource_metadata=\"https://${var.domain}/.well-known/oauth-protected-resource\""
      override = false
    }
  }
}

locals {
  function_url_host = trimsuffix(trimprefix(aws_lambda_function_url.server.function_url, "https://"), "/")
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "memory-vault hosted tier"
  aliases         = [var.domain]
  price_class     = "PriceClass_100"

  origin {
    domain_name = local.function_url_host
    origin_id   = "lambda"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "lambda"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    # Managed policies: CachingDisabled + AllViewerExceptHostHeader (the
    # origin must be addressed by its own Host for Lambda URL routing).
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  ordered_cache_behavior {
    path_pattern           = "/mcp*"
    target_origin_id       = "lambda"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id   = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.mcp_auth_header.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.main.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "apex_a" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "apex_aaaa" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}

