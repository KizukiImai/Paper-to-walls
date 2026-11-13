[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')]
    [string]$RepositoryName = 'paper-to-walls'
)

# Creates a NEW private repository and publishes only the prepared master commit.
# No force push, no token files, and no changes to global Git configuration.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Owner = 'KizukiImai'
$Repository = "$Owner/$RepositoryName"
$RemoteUrl = "https://github.com/$Repository.git"
$PreviousHost = $env:GH_HOST

function Invoke-Checked {
    param([string]$Program, [string[]]$ArgumentList)
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 can treat native stderr as a PowerShell error.
        # Check the process exit code instead; preserve interactive authentication.
        $ErrorActionPreference = 'Continue'
        & $Program @ArgumentList
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($code -ne 0) {
        throw "$Program failed (exit $code). Nothing will be force-pushed."
    }
}

Push-Location $PSScriptRoot
try {
    foreach ($program in @('git', 'gh')) {
        if (-not (Get-Command $program -ErrorAction SilentlyContinue)) {
            $package = if ($program -eq 'git') { 'Git.Git' } else { 'GitHub.cli' }
            throw "Missing $program. Install it with: winget install --id $package --exact ; then reopen this launcher."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.git') -PathType Container)) {
        throw 'The prepared .git directory is missing. Extract the complete master-ready ZIP into a new folder.'
    }
    $branch = (Invoke-Checked 'git' @('branch', '--show-current') | Out-String).Trim()
    if ($branch -ne 'master') { throw "Expected master, found '$branch'. No branch will be renamed." }
    $dirty = (Invoke-Checked 'git' @('status', '--porcelain') | Out-String).Trim()
    if ($dirty) { throw 'The prepared source has uncommitted changes. Review and commit them before publishing.' }

    # Explicitly target github.com; never send authentication to another GH_HOST.
    $env:GH_HOST = 'github.com'
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & gh auth status --hostname github.com 1>$null 2>$null
    $authCode = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    if ($authCode -ne 0) {
        Invoke-Checked 'gh' @('auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https')
    }
    $login = (Invoke-Checked 'gh' @('api', 'user', '--hostname', 'github.com', '--jq', '.login') | Out-String).Trim()
    if ($login -ne $Owner) {
        throw "Authenticated as '$login', not '$Owner'. Run: gh auth switch --hostname github.com --user $Owner"
    }

    $statePath = Join-Path $PSScriptRoot '.git/paper-to-walls-publish.json'
    $remotes = @(Invoke-Checked 'git' @('remote'))
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($state.repository -ne $Repository -or $state.createdByThisScript -ne $true) {
            throw 'A different publish attempt already exists. Use a fresh extracted copy for another repository.'
        }
        Write-Host "Resuming the previous publish to $Repository."
        $repoJson = Invoke-Checked 'gh' @('repo', 'view', $Repository, '--json', 'isPrivate,nameWithOwner')
        $existingRepo = ($repoJson | Out-String) | ConvertFrom-Json
        if ($existingRepo.isPrivate -ne $true -or $existingRepo.nameWithOwner -ne $Repository) {
            throw 'The repository is not the expected private destination. Stopping without a push.'
        }
    } else {
        if ($remotes.Count -ne 0) { throw 'A remote already exists. Refusing to change or publish to an existing remote.' }
        Write-Host "Creating NEW PRIVATE repository: $Repository"
        # If the name is already taken, gh fails here. Existing repositories are never reused.
        Invoke-Checked 'gh' @('repo', 'create', $Repository, '--private', '--description', 'Hand-drawn floor plans to Unity wall JSON, with LAN transfer and adjustable line correction.', '--disable-wiki')
        @{ repository = $Repository; createdByThisScript = $true } |
            ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    }

    if ($remotes -contains 'origin') {
        $actualRemote = (Invoke-Checked 'git' @('remote', 'get-url', 'origin') | Out-String).Trim()
        if ($actualRemote -ne $RemoteUrl) { throw "Unexpected origin: $actualRemote. It will not be replaced." }
    } else {
        Invoke-Checked 'git' @('remote', 'add', 'origin', $RemoteUrl)
    }

    # Use gh's existing credentials for this invocation only; do not print/store tokens.
    Invoke-Checked 'git' @('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--set-upstream', 'origin', 'master')
    Invoke-Checked 'gh' @('repo', 'edit', $Repository, '--default-branch', 'master')

    $localHead = (Invoke-Checked 'git' @('rev-parse', 'HEAD') | Out-String).Trim()
    $remoteHead = (Invoke-Checked 'gh' @('api', "repos/$Repository/git/ref/heads/master", '--hostname', 'github.com', '--jq', '.object.sha') | Out-String).Trim()
    $metadataText = Invoke-Checked 'gh' @('repo', 'view', $Repository, '--json', 'nameWithOwner,isPrivate,defaultBranchRef,url')
    $metadata = ($metadataText | Out-String) | ConvertFrom-Json
    if ($localHead -ne $remoteHead -or $metadata.isPrivate -ne $true -or $metadata.defaultBranchRef.name -ne 'master') {
        throw 'Post-push verification did not match. Inspect the repository; no force push will be attempted.'
    }
    Write-Host ''
    Write-Host 'SUCCESS: private repository, master branch, and commit SHA verified.' -ForegroundColor Green
    Write-Host $metadata.url
    Write-Host "Commit: $remoteHead"
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host 'Publishing has NOT been confirmed. No existing repository was force-overwritten.'
    exit 1
} finally {
    $env:GH_HOST = $PreviousHost
    Pop-Location
}
