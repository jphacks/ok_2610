# テキストクリーナーの拡張を、MDM を使わずにこのパソコン1台で管理サーバーにつなぐ（試す用）。
# 管理画面で発行した「そのままの JSON」（初期設定）をクリップボードから読み、
# Chrome の拡張向けポリシーとして、今のユーザーのレジストリ（HKCU）に書く。
# HKCU\Software\Policies はふつうの権限では書けないので、「管理者として実行」した PowerShell で動かす。
# 登録トークンは画面に出さない。
#
# つなぐ:   powershell -ExecutionPolicy Bypass -File scripts\connect-extension-windows.ps1 -ExtensionId <拡張のID>
# 元に戻す: powershell -ExecutionPolicy Bypass -File scripts\connect-extension-windows.ps1 -ExtensionId <拡張のID> -Remove

param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'ポリシーの置き場所は管理者しか書けません。スタートメニューで PowerShell（またはターミナル）を右クリックし、「管理者として実行」で開いてから実行してください。'
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "拡張の ID は a から p までの英字32文字です（chrome://extensions のテキストクリーナーの欄に出ています）: $ExtensionId"
}
$base = "HKCU:\Software\Policies\Google\Chrome\3rdparty\extensions\$ExtensionId"

if ($Remove) {
  if (Test-Path $base) { Remove-Item -Path $base -Recurse }
  Write-Host 'レジストリから消しました。chrome://policy で「ポリシーを再読み込み」を押してください。'
  exit 0
}

$raw = Get-Clipboard -Raw
if (-not $raw) { throw 'クリップボードが空です。管理画面の「そのままの JSON」の「コピー」を押してから実行してください。' }
try { $bootstrap = $raw | ConvertFrom-Json } catch { throw 'クリップボードの中身が JSON ではありません。管理画面の「そのままの JSON」をコピーしてください。' }

$m = $bootstrap.management
# Google 管理コンソール用の形（{ "management": { "Value": { ... } } }）でも受け付ける
if ($m -and $m.Value) { $m = $m.Value }
if (-not $m -or -not $m.endpoint -or -not $m.enrollmentToken -or -not $m.policyPublicKey) {
  throw '初期設定に management.endpoint・enrollmentToken・policyPublicKey がそろっていません。'
}
if ($m.endpoint -notmatch '^https://') { throw "送信先が https ではありません: $($m.endpoint)" }
if ($m.enrollmentToken -notmatch '^tc_') { throw '登録トークンの形が違います（tc_ で始まるはずです）。' }

$key = "$base\policy\management"
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
New-ItemProperty -Path $key -Name 'endpoint' -Value ([string]$m.endpoint) -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name 'enrollmentToken' -Value ([string]$m.enrollmentToken) -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name 'policyPublicKey' -Value ([string]$m.policyPublicKey) -PropertyType String -Force | Out-Null

Write-Host "書き込みました（送信先 $($m.endpoint)。登録トークンは表示しません）。"
Write-Host '次に chrome://policy を開き、「ポリシーを再読み込み」を押してください。'
