$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 4748
$address = "http://localhost:$port"

try {
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'serve.mjs'))) {
        throw "Game server not found in $repo"
    }

    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) {
            throw 'Node.js 18 or newer was not found.'
        }

        $server = Start-Process -FilePath $node.Source -ArgumentList "serve.mjs --port $port" -WorkingDirectory $repo -PassThru
        $deadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 300
            $server.Refresh()
            $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($listener) { break }
            if ($server.HasExited) { throw 'The server stopped during startup. Check its console window.' }
        } while ((Get-Date) -lt $deadline)

        if (-not $listener) { throw "The server did not open port $port within 15 seconds." }
    }

    Start-Process $address
}
catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, 'Tank Arena V2') | Out-Null
}
