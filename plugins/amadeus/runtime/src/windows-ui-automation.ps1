param(
  [Parameter(Mandatory = $true)][string]$PlanPath,
  [Parameter(Mandatory = $true)][ValidateSet('inspect', 'execute')][string]$Mode
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
if ($plan.schemaVersion -ne 1 -or $null -eq $plan.application) { throw 'Invalid Windows UI plan' }

$processBase = [IO.Path]::GetFileNameWithoutExtension([string]$plan.application.processName)
$processName = [string]$plan.application.processName
if ($processName -notmatch '^[A-Za-z0-9._-]{1,96}\.exe$') { throw 'Windows UI process name must be an exact executable name' }
$titleMatch = [string]$plan.application.windowTitleContains
if ($titleMatch.Length -lt 5 -or $titleMatch.Length -gt 120) { throw 'Windows UI window title match is missing or too broad' }
$processes = @(Get-Process -Name $processBase -ErrorAction SilentlyContinue)
if ($processes.Count -eq 0) { throw "Bound application process is not running: $processBase" }
$ids = [Collections.Generic.HashSet[int]]::new()
foreach ($process in $processes) { [void]$ids.Add($process.Id) }

$root = [Windows.Automation.AutomationElement]::RootElement
$windows = @($root.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition) | Where-Object {
  $ids.Contains($_.Current.ProcessId) -and $_.Current.Name.IndexOf($titleMatch, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($windows.Count -ne 1) { throw "Expected exactly one bound application window; found $($windows.Count)" }
$window = $windows[0]

$controls = @{}
foreach ($control in @($plan.controls)) {
  $supportedActions = @('invoke', 'setValue', 'select', 'toggle', 'expand', 'collapse')
  if (@($control.actions).Count -lt 1 -or @($control.actions | Where-Object { $supportedActions -notcontains [string]$_ }).Count -gt 0) { throw 'Unsupported control action allowlist' }
  $controls[[string]$control.key] = $control
}
$results = [Collections.Generic.List[object]]::new()

foreach ($action in @($plan.actions)) {
  switch ([string]$action.type) {
    'inspect' {
      $children = @($window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | Select-Object -First 500 | ForEach-Object {
        [ordered]@{ name = $_.Current.Name; automationId = $_.Current.AutomationId; controlType = $_.Current.ControlType.ProgrammaticName; enabled = $_.Current.IsEnabled }
      })
      $results.Add([ordered]@{ action = 'inspect'; window = $window.Current.Name; processId = $window.Current.ProcessId; controls = $children })
    }
    'focus' {
      if ($Mode -eq 'execute') { $window.SetFocus() }
      $results.Add([ordered]@{ action = 'focus'; applied = ($Mode -eq 'execute'); window = $window.Current.Name })
    }
    { $_ -in @('invoke', 'setValue', 'select', 'toggle', 'expand', 'collapse') } {
      $control = $controls[[string]$action.control]
      if ($null -eq $control -or @($control.actions) -notcontains [string]$action.type) { throw 'Action references a control that does not allow it' }
      $conditions = [Collections.Generic.List[Windows.Automation.Condition]]::new()
      if ([string]$control.automationId) { $conditions.Add([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$control.automationId)) }
      if ([string]$control.name) { $conditions.Add([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, [string]$control.name)) }
      $condition = if ($conditions.Count -eq 1) { $conditions[0] } else { [Windows.Automation.AndCondition]::new($conditions.ToArray()) }
      $matches = @($window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition))
      if ($matches.Count -ne 1) { throw "Expected exactly one allowlisted control; found $($matches.Count)" }
      if ($Mode -eq 'execute') {
        $pattern = $null
        switch ([string]$action.type) {
          'invoke' {
            if (-not $matches[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw 'Control does not support InvokePattern' }
            ([Windows.Automation.InvokePattern]$pattern).Invoke()
          }
          'setValue' {
            if (-not $matches[0].TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw 'Control does not support ValuePattern' }
            ([Windows.Automation.ValuePattern]$pattern).SetValue([string]$action.value)
          }
          'select' {
            if (-not $matches[0].TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { throw 'Control does not support SelectionItemPattern' }
            ([Windows.Automation.SelectionItemPattern]$pattern).Select()
          }
          'toggle' {
            if (-not $matches[0].TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { throw 'Control does not support TogglePattern' }
            ([Windows.Automation.TogglePattern]$pattern).Toggle()
          }
          'expand' {
            if (-not $matches[0].TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { throw 'Control does not support ExpandCollapsePattern' }
            ([Windows.Automation.ExpandCollapsePattern]$pattern).Expand()
          }
          'collapse' {
            if (-not $matches[0].TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { throw 'Control does not support ExpandCollapsePattern' }
            ([Windows.Automation.ExpandCollapsePattern]$pattern).Collapse()
          }
        }
      }
      $results.Add([ordered]@{ action = [string]$action.type; applied = ($Mode -eq 'execute'); control = [string]$action.control })
    }
    default { throw 'Unsupported Windows UI action' }
  }
}

foreach ($result in $results) { $result | ConvertTo-Json -Compress -Depth 8 }
