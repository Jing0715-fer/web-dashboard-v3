' ============================================
'  Web Dashboard - SILENT launcher (no window)
' ============================================
'
'  Double-click to start the dashboard completely hidden:
'    - No console window appears at all.
'    - All output is written to logs\dashboard-console.log.
'    - The browser opens automatically once the server is up.
'
'  Stop the hidden dashboard: run stop-dashboard.bat
'  Prefer a visible server log? Run start-dashboard.bat instead.
'
Option Explicit

Dim fso, shell, root, logDir, logFile, q, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Folder of this script (correct even when launched from another cwd).
Set root = fso.GetFolder(fso.GetParentFolderName(WScript.ScriptFullName))

logDir = root.Path & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
logFile = logDir & "\dashboard-console.log"

' Remove the previous run's log so the file always reflects the latest start
' (if nothing seems to happen, open it - setup errors land here).
On Error Resume Next
fso.DeleteFile logFile, True
On Error GoTo 0

q = Chr(34)

' SILENT=1 tells start-dashboard.bat to skip interactive `pause` prompts -
' in a hidden console nobody could ever press a key.
shell.Environment("PROCESS")("SILENT") = "1"

' Run the start script in a HIDDEN console (window style 0), don't wait:
'   cmd.exe /c ""<bat>" > "<log>" 2>&1"
cmd = "cmd.exe /c " & q & q & root.Path & "\start-dashboard.bat" & q & _
      " > " & q & logFile & q & " 2>&1" & q
shell.Run cmd, 0, False

' Brief auto-closing confirmation so a double-click never feels like a no-op.
' (Closes by itself after 5 seconds.)
Call shell.Popup( _
  "Dashboard is starting hidden (no console window)." & vbCrLf & vbCrLf & _
  "http://localhost:3000 will open automatically." & vbCrLf & _
  "Log: logs\dashboard-console.log" & vbCrLf & _
  "Stop: run stop-dashboard.bat", _
  5, "Web Dashboard", 64)
