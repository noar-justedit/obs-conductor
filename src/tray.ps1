# OBS Conductor - icon in the Windows notification area (system tray).
#
# Started by the app itself (src/tray.js), hidden; stops when the app stops.
# Every 1.5 s it asks the app (http://127.0.0.1:PORT/api/tray) what to show:
# tooltip, menu status lines, icon (dot: green all good, orange needs a look,
# red connection lost) and new notifications. Plain Windows PowerShell 5.1 +
# WinForms: nothing to install.

param(
  [int]$Port = 8090,
  [int]$ParentPid = 0,
  [string]$IconDir = '',
  [string]$LogFile = ''
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
# Started hidden by the app: Windows hides the FIRST window this process
# shows. An invisible window takes it, so the Quit question (a message box)
# and the menu really show.
$eat = New-Object System.Windows.Forms.Form -Property @{ShowInTaskbar=$false; FormBorderStyle='None'; Opacity=0; Width=1; Height=1}
$eat.Show(); $eat.Hide()

$base = "http://127.0.0.1:$Port"
$icons = @{}
foreach ($n in @('app', 'tray_ok', 'tray_warn', 'tray_error')) {
  $f = Join-Path $IconDir "$n.ico"
  if (Test-Path $f) { $icons[$n] = New-Object System.Drawing.Icon $f }
}

function Call-App([string]$path, [string]$method = 'GET') {
  $req = [System.Net.HttpWebRequest]::Create("$base$path")
  $req.Method = $method
  $req.Timeout = 1500
  $req.Proxy = $null
  if ($method -eq 'POST') { $req.ContentLength = 0 }
  $resp = $req.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    return $reader.ReadToEnd() | ConvertFrom-Json
  } finally { $resp.Close() }
}

$ni = New-Object System.Windows.Forms.NotifyIcon
if ($icons['app']) { $ni.Icon = $icons['app'] }
$ni.Text = 'OBS Conductor'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$line1 = $menu.Items.Add('OBS Conductor'); $line1.Enabled = $false
$line2 = $menu.Items.Add(''); $line2.Enabled = $false; $line2.Visible = $false
[void]$menu.Items.Add('-')
$open = $menu.Items.Add('Open the dock in a browser')
$open.add_Click({ Start-Process "http://localhost:$Port/" })
$log = $menu.Items.Add('Show the log')
$log.add_Click({ if ($LogFile -and (Test-Path $LogFile)) { Start-Process notepad.exe -ArgumentList "`"$LogFile`"" } })
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('Quit OBS Conductor')
$quit.add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "Quit OBS Conductor?",
    'OBS Conductor', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  try { [void](Call-App '/api/app/quit' 'POST') } catch {}
  $ni.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu
$ni.add_DoubleClick({ Start-Process "http://localhost:$Port/" })

$script:seq = 0
$script:level = 'app'
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.add_Tick({
  if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    $ni.Visible = $false
    [System.Windows.Forms.Application]::Exit()
    return
  }
  try { $s = Call-App "/api/tray?since=$($script:seq)" } catch { return }
  if ($s.tooltip) { $ni.Text = $s.tooltip }
  if ($s.level -and $s.level -ne $script:level -and $icons[$s.level]) { $ni.Icon = $icons[$s.level]; $script:level = $s.level }
  $line1.Text = $s.line1
  $line2.Text = [string]$s.line2
  $line2.Visible = [bool]$s.line2
  foreach ($n in $s.notes) {
    $kind = [System.Windows.Forms.ToolTipIcon]::Info
    if ($n.icon -eq 'warning') { $kind = [System.Windows.Forms.ToolTipIcon]::Warning }
    if ($n.icon -eq 'error') { $kind = [System.Windows.Forms.ToolTipIcon]::Error }
    $ni.ShowBalloonTip(6000, [string]$n.title, [string]$n.text, $kind)
    $script:seq = $n.seq
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
$ni.Dispose()
