# Publish dsh-trash-can to GitHub.
#
#   1. winget install --id GitHub.cli
#   2. gh auth login          (choose GitHub.com → HTTPS → browser)
#   3. pwsh -File publish.ps1 -Owner <your-github-user>
#
# The script creates the repository when it does not exist yet, then pushes the
# current branch. It never stores a token; auth lives in the Windows credential
# store managed by the GitHub CLI.

param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [string]$Name = 'dsh-trash-can',
  [ValidateSet('public', 'private')][string]$Visibility = 'public'
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'GitHub CLI not found. Run: winget install --id GitHub.cli'
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'GitHub CLI is not signed in. Run: gh auth login'
}

$repo = "$Owner/$Name"
$exists = gh repo view $repo 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "creating $repo ($Visibility) ..."
  gh repo create $repo --$Visibility --source . --remote origin --description '垃圾桶：把归档后的会话搬进可还原的回收站，360 小时后自动彻底删除'
} else {
  Write-Host "repository $repo already exists"
  if (-not (git remote get-url origin 2>$null)) { git remote add origin "https://github.com/$repo.git" }
}

git remote set-url origin "https://github.com/$repo.git"
git push -u origin HEAD

Write-Host ''
Write-Host "done: https://github.com/$repo"
Write-Host "install on any machine with:"
Write-Host "  dsh plugin --profile web add github:$repo"
