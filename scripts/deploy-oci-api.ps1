param(
  [string]$HostName = "sh-oracle-cloud-dev-1",
  [string]$RemotePath = "/home/ubuntu/living-cost-manager",
  [string]$ServiceName = "living-cost-manager-api.service",
  [string]$ApiBasePath = "/living-cost-manager/v1",
  [int]$Port = 4104,
  [switch]$WriteEnv
)

$ErrorActionPreference = "Stop"

function Invoke-Remote {
  param([string]$Command)
  ssh $HostName "set -e; $Command"
  if ($LASTEXITCODE -ne 0) {
    throw "Remote command failed with exit code $LASTEXITCODE."
  }
}

if ($WriteEnv) {
  if ([string]::IsNullOrWhiteSpace($env:LCM_DATABASE_URL) -or [string]::IsNullOrWhiteSpace($env:LCM_JWT_SECRET)) {
    throw "Set LCM_DATABASE_URL and LCM_JWT_SECRET in the local shell before using -WriteEnv. Values are not printed."
  }

  $envContent = @(
    "NODE_ENV=production"
    "PORT=$Port"
    "API_BASE_PATH=$ApiBasePath"
    "CORS_ORIGIN=https://sanghyun-io.github.io"
    "DATABASE_URL=$($env:LCM_DATABASE_URL)"
    "JWT_SECRET=$($env:LCM_JWT_SECRET)"
  ) -join "`n"

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($envContent)
  $encoded = [Convert]::ToBase64String($bytes)
  Invoke-Remote "mkdir -p '$RemotePath' && printf '%s' '$encoded' | base64 -d > '$RemotePath/.env.oci' && chmod 600 '$RemotePath/.env.oci'"
}

Invoke-Remote "mkdir -p '$RemotePath'"
Invoke-Remote "cd '$RemotePath' && git fetch origin main && git checkout -B main origin/main"
Invoke-Remote "cd '$RemotePath' && corepack pnpm install --frozen-lockfile --prod=false"
Invoke-Remote "cd '$RemotePath' && set -a && . ./.env.oci && set +a && corepack pnpm --filter @living-cost-manager/api build"
Invoke-Remote "cd '$RemotePath' && set -a && . ./.env.oci && set +a && ./node_modules/.bin/prisma migrate deploy"

$preRestart = Invoke-Remote "curl -fsS 'http://127.0.0.1:$Port$ApiBasePath/health'"
if ($preRestart -notmatch '"ok"\s*:\s*true') {
  throw "Pre-restart health check failed."
}

Invoke-Remote "sudo systemctl restart '$ServiceName'"

$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Seconds 2
  try {
    $postRestart = Invoke-Remote "curl -fsS 'http://127.0.0.1:$Port$ApiBasePath/health'"
    if ($postRestart -match '"ok"\s*:\s*true') {
      Invoke-Remote "sudo nginx -t && sudo systemctl reload nginx"
      Invoke-WebRequest -Uri "https://api.gamja.top$ApiBasePath/health" -UseBasicParsing | ForEach-Object {
        [pscustomobject]@{
          ok = $true
          publicStatus = $_.StatusCode
          service = $ServiceName
          apiBasePath = $ApiBasePath
        } | ConvertTo-Json -Compress
      }
      exit 0
    }
  } catch {
    if ((Get-Date) -ge $deadline) {
      throw
    }
  }
} while ((Get-Date) -lt $deadline)

throw "Post-restart health check did not become healthy before timeout."
