param(
  [string]$ApiBaseUrl = "https://api.gamja.top/living-cost-manager/v1",
  [string]$EmailDomain = "example.com",
  [switch]$SkipSharing
)

$ErrorActionPreference = "Stop"

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null,
    [hashtable]$Headers = @{}
  )

  $request = @{
    Method = $Method
    Uri = $Uri
    Headers = $Headers
  }

  if ($null -ne $Body) {
    $request.ContentType = "application/json"
    $request.Body = ($Body | ConvertTo-Json -Depth 12)
  }

  Invoke-RestMethod @request
}

$base = $ApiBaseUrl.TrimEnd("/")
$runId = [guid]::NewGuid().ToString("N").Substring(0, 12)
$password = "password123"
$ownerEmail = "smoke-owner-$runId@$EmailDomain"
$inviteeEmail = "smoke-invitee-$runId@$EmailDomain"

$health = Invoke-WebRequest -Uri "$base/health" -UseBasicParsing
if ($health.StatusCode -ne 200) {
  throw "Health check failed with status $($health.StatusCode)."
}

$owner = Invoke-JsonRequest -Method Post -Uri "$base/auth/register" -Body @{
  email = $ownerEmail
  password = $password
  name = "Smoke Owner"
}

$login = Invoke-JsonRequest -Method Post -Uri "$base/auth/login" -Body @{
  email = $ownerEmail
  password = $password
}

$ownerHeaders = @{ Authorization = "Bearer $($login.token)" }
$me = Invoke-JsonRequest -Method Get -Uri "$base/me" -Headers $ownerHeaders
$workspaces = Invoke-JsonRequest -Method Get -Uri "$base/workspaces" -Headers $ownerHeaders
$workspace = $workspaces | Select-Object -First 1

if (!$me.user.id -or !$workspace.id) {
  throw "Auth smoke did not return a user and workspace."
}

$snapshot = @{
  workspaceId = $workspace.id
  monthlyIncome = 3210000
  categories = @(
    @{
      id = "other"
      workspaceId = $workspace.id
      label = "기타"
    }
  )
  cards = @()
  fixedCosts = @(
    @{
      id = "smoke-cost"
      workspaceId = $workspace.id
      name = "스모크 지출"
      categoryId = "other"
      paymentMethodId = "bank-transfer"
      paymentOptionId = "auto-transfer"
      amount = 12345
      periodMonths = 2.5
      billingDay = 7
    }
  )
}

Invoke-JsonRequest -Method Put -Uri "$base/workspaces/$($workspace.id)/snapshot" -Headers $ownerHeaders -Body $snapshot | Out-Null
$savedSnapshot = Invoke-JsonRequest -Method Get -Uri "$base/workspaces/$($workspace.id)/snapshot" -Headers $ownerHeaders

if ([double]$savedSnapshot.fixedCosts[0].periodMonths -ne 2.5) {
  throw "Snapshot smoke did not preserve decimal periodMonths."
}

$memberCount = 1
if (!$SkipSharing) {
  $invitee = Invoke-JsonRequest -Method Post -Uri "$base/auth/register" -Body @{
    email = $inviteeEmail
    password = $password
    name = "Smoke Invitee"
  }
  $inviteeHeaders = @{ Authorization = "Bearer $($invitee.token)" }
  $invitation = Invoke-JsonRequest -Method Post -Uri "$base/workspaces/$($workspace.id)/invitations" -Headers $ownerHeaders -Body @{
    email = $inviteeEmail
    role = "viewer"
  }

  Invoke-JsonRequest -Method Post -Uri "$base/invitations/$($invitation.id)/accept" -Headers $inviteeHeaders -Body @{
    token = $invitation.token
  } | Out-Null

  $members = Invoke-JsonRequest -Method Get -Uri "$base/workspaces/$($workspace.id)/members" -Headers $ownerHeaders
  $memberCount = @($members).Count
}

[pscustomobject]@{
  ok = $true
  apiBaseUrl = $base
  healthStatus = $health.StatusCode
  workspaceCount = @($workspaces).Count
  snapshotPeriodMonths = [double]$savedSnapshot.fixedCosts[0].periodMonths
  memberCount = $memberCount
  disposableEmailPattern = "smoke-*-$runId@$EmailDomain"
  cleanup = "Public cleanup is intentionally unavailable for last-owner accounts; use DB/schema maintenance if cleanup is required."
} | ConvertTo-Json -Compress
