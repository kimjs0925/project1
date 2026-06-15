# Run this PowerShell script as Administrator to allow classroom devices to reach the app.
$ruleName = "Social Emotional App 3000 LocalSubnet"

Try {
  $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Output "Firewall rule already exists: $ruleName"
    exit 0
  }

  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 3000 `
    -RemoteAddress LocalSubnet `
    -Profile Any `
    -ErrorAction Stop

  Write-Output "Firewall rule added: TCP 3000 allowed from LocalSubnet."
} Catch {
  Write-Error "Failed to add firewall rule. Please run PowerShell as Administrator. $_"
  exit 1
}
