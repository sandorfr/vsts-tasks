[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$TaskDirectory,
    [string]$TargetPath)

$ErrorActionPreference = 'Stop'

# Determine the target path.
$defaultFileName = "Install-TaskUpdate.ps1"
if (!$TargetPath) {
    $TargetPath = $defaultFileName
} elseif ((Test-Path $TargetPath -PathType Container)) {
    $TargetPath = [System.IO.Path]::Combine($TargetPath, $defaultFileName)
}

# Build the script content.
$content = New-Object System.Text.StringBuilder
$null = $content.AppendLine(@'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CollectionUrl)

$ErrorActionPreference = 'Stop'

function Install-Task {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$CollectionUrl,

        [Parameter(Mandatory = $true)]
        $Task)

    "Installing task '$($Task.Name)'."
    $url = "$($CollectionUrl.TrimEnd('/'))/_apis/distributedtask/tasks/$($Task.Id)/?overwrite=false&api-version=2.0"

    # Format the content.
    [byte[]]$bytes = [System.Convert]::FromBase64String($Task.Base64Zip)

    # Send the HTTP request.
    Invoke-RestMethod -Uri $url -Method Put -Body $bytes -UseDefaultCredentials -Headers @{
        #'Authorization' = "Basic $([System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(":$Pat")))"
        'X-TFS-FedAuthRedirect' = 'Suppress'
        'Content-Range' = "bytes 0-$($bytes.Length - 1)/$($bytes.Length)"
        'Content-Type' = 'application/octet-stream'
    }
}

$tasks = @(
'@)

foreach ($taskDir in $TaskDirectory) {
    # Validate the directory exists.
    if (!(Test-Path $taskDir -PathType Container)) {
        throw "Directory does not exist: '$taskDir'."
    }

    # Resolve the directory info.
    $taskDir = Get-Item $taskDir

    # Deserialize the task.json.
    $manifest = Get-Item ([System.IO.Path]::Combine($TaskDirectory, "task.json")) |
        Get-Content -Encoding UTF8 |
        Out-String |
        ConvertFrom-Json

    # Get the zip bytes.
    $zipFile = "$($taskDir.FullName.TrimEnd('/', '\')).temp.zip"
    if ((Test-Path -LiteralPath $zipFile -PathType Leaf)) {
        Remove-Item -LiteralPath $zipFile
    }

    try {
        $items = Get-ChildItem -LiteralPath $taskDir.FullName |
            ForEach-Object { $_.FullName }
        Compress-Archive -Path $items -DestinationPath $zipFile
        $base64Zip = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Get-Item -LiteralPath $zipFile).FullName))
    } finally {
        if ((Test-Path -LiteralPath $zipFile -PathType Leaf)) {
            Remove-Item -LiteralPath $zipFile
        }
    }

    # Embed the task into the script.
    $id = "$($manifest.Id)"
    $name = "$($manifest.Name)"
    $null = $content.AppendLine(@"
    @{
        Id = '$($id.Replace("'", "''"))'
        Name = '$($name.Replace("'", "''"))'
        Base64Zip = '$base64Zip'
    }
"@)
}

$null = $content.AppendLine(@'
)

foreach ($task in $tasks) {
    Install-Task -CollectionUrl $CollectionUrl -Task $task
}
'@)

Set-Content $TargetPath -Value $content.ToString() -Encoding UTF8