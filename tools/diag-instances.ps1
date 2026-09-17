$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$procs = Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'"
Write-Output ("total ChatGPT.exe processes: " + $procs.Count)

# Electron: 主行程沒有 --type 參數；每個主行程 = 一個獨立 app 實體
$mains = $procs | Where-Object { $_.CommandLine -notmatch '--type=' }
Write-Output ("main instances: " + $mains.Count)
foreach ($m in $mains) {
    $cl = $m.CommandLine
    $flag = if ($cl -match 'remote-debugging-port=(\d+)') { "DEBUG_PORT=" + $Matches[1] } else { "NO_DEBUG_FLAG" }
    Write-Output ("  main pid=" + $m.ProcessId + "  " + $flag)
    Write-Output ("  cmd: " + $cl.Substring(0, [Math]::Min(200, $cl.Length)))
}

# 有可見視窗標題的行程
Write-Output "--- window titles ---"
Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle } |
    ForEach-Object { Write-Output ("  pid=" + $_.Id + "  title=[" + $_.MainWindowTitle + "]") }
