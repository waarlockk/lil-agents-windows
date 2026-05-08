$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $Root
$Out = Join-Path $Root "assets"
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$Inputs = @(
  @{ Name = "walk-bruce-01"; Path = Join-Path $RepoRoot "LilAgents\walk-bruce-01.mov" },
  @{ Name = "walk-jazz-01"; Path = Join-Path $RepoRoot "LilAgents\walk-jazz-01.mov" }
)

foreach ($Input in $Inputs) {
  $Target = Join-Path $Out "$($Input.Name).webm"
  ffmpeg -y -i $Input.Path -vf "scale=540:-1" -c:v libvpx-vp9 -b:v 0 -crf 34 -an $Target
}
