@echo off
REM ============================================
REM  Root convenience wrapper for the Windows agent
REM ============================================
REM
REM  Start the agent from the REPO ROOT without
REM  cd-ing into mini-services\agent-win first:
REM
REM    start-agent.bat                  (default port 3100)
REM    start-agent.bat 3101             (custom port)
REM    start-agent.bat 3200 my-secret   (port + API key)
REM
REM  The real script is mini-services\agent-win\start.bat
REM  (it cds to its own folder, so DB paths stay correct).
REM  Foreground window - closing the window stops the agent.
REM  For background mode use start-service.bat inside
REM  mini-services\agent-win instead.

call "%~dp0mini-services\agent-win\start.bat" %*
