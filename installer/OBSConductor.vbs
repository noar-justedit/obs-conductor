' OBS Conductor - launcher installed next to OBSConductor.exe (Start menu,
' Windows startup). Runs the app in the background, without any window.
' Its messages go to %LOCALAPPDATA%\OBSConductor\logs\OBSConductor.log
'
'   wscript OBSConductor.vbs              start the app (if not running yet)
'   wscript OBSConductor.vbs --simulate   start it with a simulated OBS
'   wscript OBSConductor.vbs /stop        stop it
'   wscript OBSConductor.vbs /adddock     add the dock to OBS again (OBS closed)
'   wscript OBSConductor.vbs /log         open the log
'   wscript OBSConductor.vbs /autostart   start with Windows: quiet if already running

Option Explicit
Const TITLE = "OBS Conductor"
Dim fso, sh, dir, exe, mode, args, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = """" & dir & "\OBSConductor.exe"" "
sh.CurrentDirectory = dir

mode = ""
args = ""
For i = 0 To WScript.Arguments.Count - 1
  If Left(WScript.Arguments(i), 1) = "/" Then
    mode = LCase(WScript.Arguments(i))
  Else
    args = args & " """ & WScript.Arguments(i) & """"
  End If
Next

' The app's processes (OBSConductor.exe running main.js)
Function AppProcesses()
  Set AppProcesses = GetObject("winmgmts:\\.\root\cimv2").ExecQuery( _
    "SELECT * FROM Win32_Process WHERE Name = 'OBSConductor.exe' AND CommandLine LIKE '%main.js%'")
End Function

Function LogFile()
  LogFile = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\OBSConductor\logs\OBSConductor.log"
End Function

' started with Windows (2.3.0: for every user): no message if it already runs
Dim auto
auto = (mode = "/autostart")
If auto Then mode = ""

Select Case mode
  Case "/stop"
    Dim p, n, failed
    n = 0
    failed = 0
    For Each p In AppProcesses()
      If p.Terminate() = 0 Then
        n = n + 1
      Else
        failed = failed + 1
      End If
    Next
    If failed > 0 Then
      MsgBox "OBS Conductor could not be stopped. End OBSConductor.exe in the Task Manager.", vbExclamation, TITLE
    ElseIf n > 0 Then
      MsgBox "OBS Conductor is stopped.", vbInformation, TITLE
    Else
      MsgBox "OBS Conductor was not running.", vbInformation, TITLE
    End If

  Case "/adddock"
    Dim rc
    rc = sh.Run(exe & """" & dir & "\app\src\obs-setup.js"" install", 0, True)
    Select Case rc
      Case 0
        MsgBox "Done: OBS > Docks > OBS Conductor.", vbInformation, TITLE
      Case 3
        MsgBox "Close OBS, then try again.", vbExclamation, TITLE
      Case 4
        MsgBox "Open OBS once, close it, then try again.", vbExclamation, TITLE
      Case Else
        MsgBox "The dock could not be added." & vbCrLf & _
               "By hand: OBS > Docks > Custom Browser Docks, URL http://localhost:8090/", vbExclamation, TITLE
    End Select

  Case "/log"
    If fso.FileExists(LogFile()) Then
      sh.Run "notepad.exe """ & LogFile() & """", 1, False
    Else
      MsgBox "No log yet.", vbInformation, TITLE
    End If

  Case Else
    If AppProcesses().Count > 0 Then
      If Not auto Then MsgBox "OBS Conductor is already running.", vbInformation, TITLE
      WScript.Quit 0
    End If
    sh.Run exe & """" & dir & "\app\src\main.js""" & args, 0, False
    ' still there 3 s later? Otherwise say so (port taken, broken settings...)
    WScript.Sleep 3000
    If AppProcesses().Count = 0 Then
      If MsgBox("OBS Conductor could not start. Open the log?", vbExclamation + vbYesNo, TITLE) = vbYes Then
        If fso.FileExists(LogFile()) Then sh.Run "notepad.exe """ & LogFile() & """", 1, False
      End If
    End If
End Select
