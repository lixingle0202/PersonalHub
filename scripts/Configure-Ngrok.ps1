$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.public-runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

function ConvertFrom-NgrokTokenInput([string]$InputText) {
    # Accept the dashboard's copy-command button as well as the raw token.
    $match = [regex]::Match($InputText, '^\s*(?:ngrok(?:\.exe)?\s+config\s+add-authtoken\s+)?["'']?([A-Za-z0-9_-]{20,256})["'']?\s*$')
    if (-not $match.Success) { throw '请重新复制完整令牌，或复制 ngrok config add-authtoken 开头的整条命令。' }
    return $match.Groups[1].Value
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'PersonalHub — 配置免费固定隧道'
$form.ClientSize = [System.Drawing.Size]::new(590, 290)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.AutoScaleMode = 'Dpi'
$form.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10)

$instructions = [System.Windows.Forms.Label]::new()
$instructions.Location = [System.Drawing.Point]::new(22, 20)
$instructions.Size = [System.Drawing.Size]::new(546, 66)
$instructions.Text = "在 ngrok 网页点击 Your Authtoken，复制令牌后，`r`n点击下方输入框并按 Ctrl+V 粘贴。也可以粘贴整条配置命令。"
$form.Controls.Add($instructions)

$inputBox = [System.Windows.Forms.TextBox]::new()
$inputBox.Location = [System.Drawing.Point]::new(24, 94)
$inputBox.Size = [System.Drawing.Size]::new(540, 30)
$inputBox.UseSystemPasswordChar = $true
$inputBox.ShortcutsEnabled = $true
$inputBox.MaxLength = 512
$form.Controls.Add($inputBox)

$hint = [System.Windows.Forms.Label]::new()
$hint.Location = [System.Drawing.Point]::new(22, 138)
$hint.Size = [System.Drawing.Size]::new(546, 46)
$hint.Text = '输入会显示为圆点。令牌仅加密保存在本机，不会打印或发到聊天里。'
$form.Controls.Add($hint)

$status = [System.Windows.Forms.Label]::new()
$status.Location = [System.Drawing.Point]::new(22, 190)
$status.Size = [System.Drawing.Size]::new(546, 38)
$status.ForeColor = [System.Drawing.Color]::Firebrick
$form.Controls.Add($status)

$save = [System.Windows.Forms.Button]::new()
$save.Text = '保存配置'
$save.Location = [System.Drawing.Point]::new(436, 238)
$save.Size = [System.Drawing.Size]::new(130, 34)
$form.Controls.Add($save)
$form.AcceptButton = $save
$save.Add_Click({
    $secureToken = $null
    try {
        $parsedToken = ConvertFrom-NgrokTokenInput $inputBox.Text
        $secureToken = ConvertTo-SecureString -String $parsedToken -AsPlainText -Force
        # Windows DPAPI protects the value for this user on this computer.
        $secureToken | Export-Clixml -LiteralPath (Join-Path $runtimeRoot 'ngrok-token.xml')
        $inputBox.Clear()
        $parsedToken = $null
        [System.Windows.Forms.MessageBox]::Show('配置已保存。请回到 Codex，告诉我“配置好了”。', '保存成功', 'OK', 'Information') | Out-Null
        $form.DialogResult = 'OK'
        $form.Close()
    } catch {
        $status.Text = '未保存：请重新复制完整令牌或整条配置命令，再点“保存配置”。'
    } finally {
        $parsedToken = $null
        if ($secureToken) { $secureToken.Dispose() }
    }
})
$form.Add_Shown({ $form.Activate(); $inputBox.Focus() })
try {
    if ($form.ShowDialog() -eq 'OK') { Write-Output 'Saved.' }
} finally {
    $inputBox.Clear()
    $form.Dispose()
}
