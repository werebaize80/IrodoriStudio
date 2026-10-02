param(
  [int]$DebugPort = 9223,
  [int]$ViewportWidth = 1600,
  [int]$ViewportHeight = 1000
)

$ErrorActionPreference = 'Stop'

function Assert-That([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Emoji palette regression: $Message" }
}

function New-CdpConnection([int]$Port) {
  $target = Invoke-RestMethod "http://127.0.0.1:$Port/json" | Where-Object { $_.type -eq 'page' -and $_.url -like 'http://127.0.0.1:*' } | Select-Object -First 1
  Assert-That ($null -ne $target) "No local browser page is available on debug port $Port."
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $cts = [System.Threading.CancellationTokenSource]::new()
  $ws.ConnectAsync([uri]$target.webSocketDebuggerUrl, $cts.Token).GetAwaiter().GetResult() | Out-Null
  return [pscustomobject]@{ Socket = $ws; Cancellation = $cts; NextId = 1 }
}

function Send-Cdp($Connection, [string]$Method, $Params = @{}) {
  $id = $Connection.NextId
  $null = $Connection.NextId++
  $message = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 20
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($message)
  $Connection.Socket.SendAsync([System.ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Connection.Cancellation.Token).GetAwaiter().GetResult() | Out-Null
  while ($true) {
    $buffer = New-Object byte[] 65536
    $builder = [System.Text.StringBuilder]::new()
    do {
      $received = $Connection.Socket.ReceiveAsync([System.ArraySegment[byte]]::new($buffer), $Connection.Cancellation.Token).GetAwaiter().GetResult()
      [void]$builder.Append([System.Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count))
    } while (-not $received.EndOfMessage)
    $response = $builder.ToString() | ConvertFrom-Json
    if ($response.id -eq $id) { return $response }
  }
}

function Invoke-Js($Connection, [string]$Expression) {
  $response = Send-Cdp $Connection 'Runtime.evaluate' @{ expression = $Expression; returnByValue = $true; awaitPromise = $true }
  if ($response.result.exceptionDetails) {
    $detail = $response.result.exceptionDetails.exception.description
    if (-not $detail) { $detail = $response.result.exceptionDetails.text }
    throw "Browser JavaScript failed: $detail"
  }
  return $response.result.result.value
}

function Invoke-Mouse($Connection, [string]$Type, [double]$X, [double]$Y, [string]$Button = 'none', [int]$Buttons = 0) {
  Send-Cdp $Connection 'Input.dispatchMouseEvent' @{ type = $Type; x = $X; y = $Y; button = $Button; buttons = $Buttons; clickCount = 1; pointerType = 'mouse' } | Out-Null
}

function Invoke-Click($Connection, $Point) {
  Invoke-Mouse $Connection 'mouseMoved' $Point.x $Point.y
  Invoke-Mouse $Connection 'mousePressed' $Point.x $Point.y 'left' 1
  Invoke-Mouse $Connection 'mouseReleased' $Point.x $Point.y 'left' 0
  Start-Sleep -Milliseconds 120
}

function Get-Point($Connection, [string]$Selector, [double]$Horizontal = 0.5) {
  $selectorJson = $Selector | ConvertTo-Json -Compress
  $value = Invoke-Js $Connection "JSON.stringify((()=>{const e=document.querySelector($selectorJson);if(!e)throw new Error('missing '+$selectorJson);const r=e.getBoundingClientRect();return {x:r.left+r.width*$Horizontal,y:r.top+r.height/2};})())"
  $point = $value | ConvertFrom-Json
  Assert-That ($point.x -ne 0 -or $point.y -ne 0) "Point lookup returned 0,0 for $Selector (raw value: $value)."
  return $point
}

function Scroll-Into-View($Connection, [string]$Selector) {
  $selectorJson = $Selector | ConvertTo-Json -Compress
  Invoke-Js $Connection "document.querySelector($selectorJson)?.scrollIntoView({block:'center',inline:'nearest'});" | Out-Null
  Start-Sleep -Milliseconds 80
}

function Get-Order($Connection) {
  $value = Invoke-Js $Connection 'JSON.stringify([...document.querySelectorAll("[data-emoji-palette-item]")].map((e)=>e.dataset.emoji))'
  return @($value | ConvertFrom-Json)
}

function Same-Order([string[]]$Left, [string[]]$Right) {
  return $Left.Count -eq $Right.Count -and (@(for ($index = 0; $index -lt $Left.Count; $index++) { $Left[$index] -eq $Right[$index] }) -notcontains $false)
}

function Is-ImmediatelyAfter([string[]]$Order, [string]$Emoji, [string]$Previous) {
  $index = [array]::IndexOf($Order, $Emoji)
  return $index -gt 0 -and $Order[$index - 1] -eq $Previous
}

function Is-ImmediatelyBefore([string[]]$Order, [string]$Emoji, [string]$Following) {
  $index = [array]::IndexOf($Order, $Emoji)
  return $index -ge 0 -and $index -lt ($Order.Count - 1) -and $Order[$index + 1] -eq $Following
}

function Drag-Emoji($Connection, [string]$Dragged, [string]$Target, [bool]$After) {
  $sourceSelector = "[data-emoji='$Dragged'] .palette-drag-handle"
  $targetSelector = "[data-emoji='$Target']"
  Scroll-Into-View $Connection $sourceSelector
  $source = Get-Point $Connection $sourceSelector
  $targetPoint = Get-Point $Connection $targetSelector $(if ($After) { 0.78 } else { 0.22 })
  Invoke-Mouse $Connection 'mouseMoved' $source.x $source.y
  Invoke-Mouse $Connection 'mousePressed' $source.x $source.y 'left' 1
  Start-Sleep -Milliseconds 60
  $immediateDragging = Invoke-Js $Connection 'document.querySelector(".palette-item.dragging")?.dataset.emoji ?? null'
  foreach ($fraction in 0.12, 0.27, 0.42, 0.57, 0.72, 0.87, 1.0) {
    Invoke-Mouse $Connection 'mouseMoved' ($source.x + (($targetPoint.x - $source.x) * $fraction)) ($source.y + (($targetPoint.y - $source.y) * $fraction)) 'none' 1
    Start-Sleep -Milliseconds 45
  }
  $preview = Get-Order $Connection
  $dragging = Invoke-Js $Connection 'document.querySelector(".palette-item.dragging")?.dataset.emoji ?? null'
  Invoke-Mouse $Connection 'mouseReleased' $targetPoint.x $targetPoint.y 'left' 0
  Start-Sleep -Milliseconds 180
  return [pscustomobject]@{ ImmediateDragging = $immediateDragging; Preview = $preview; Dragging = $dragging; Result = (Get-Order $Connection) }
}

$connection = New-CdpConnection $DebugPort
try {
  Send-Cdp $connection 'Emulation.setDeviceMetricsOverride' @{ width = $ViewportWidth; height = $ViewportHeight; deviceScaleFactor = 1; mobile = $false } | Out-Null
  Invoke-Js $connection 'window.__TAURI_INTERNALS__={invoke:async(cmd,args)=>{if(cmd==="get_emoji_palette_order")return [];if(cmd==="save_emoji_palette_order"){window.__emojiPaletteOrderForTest=args.order;return null;}throw new Error("mocked command: "+cmd)}};document.querySelector(".emoji-reorder-toggle")?.scrollIntoView({block:"center"});' | Out-Null
  Start-Sleep -Milliseconds 220

  $toggle = Get-Point $connection '.emoji-reorder-toggle'
  $mode = Invoke-Js $connection 'document.querySelector(".emoji-reorder-toggle")?.getAttribute("aria-pressed")'
  if ($mode -ne 'true') {
    Invoke-Mouse $connection 'mouseMoved' $toggle.x $toggle.y
    Invoke-Mouse $connection 'mousePressed' $toggle.x $toggle.y 'left' 1
    Invoke-Mouse $connection 'mouseReleased' $toggle.x $toggle.y 'left' 0
    Start-Sleep -Milliseconds 180
  }

  $handleCount = [int](Invoke-Js $connection 'document.querySelectorAll(".palette-drag-handle").length')
  Assert-That ($handleCount -eq 45) "Expected 45 drag handles after enabling reorder mode, got $handleCount."
  $before = Get-Order $connection

  $firstTarget = if (Is-ImmediatelyAfter $before '👂' '😲') { '💋' } else { '😲' }
  $first = Drag-Emoji $connection '👂' $firstTarget $true
  Assert-That ($first.Dragging -eq '👂') "The first long drag lost its active source before release (after press: $($first.ImmediateDragging); before release: $($first.Dragging))."
  Assert-That (-not (Same-Order $before $first.Preview)) 'The first long drag did not reflow the palette.'
  Assert-That (Same-Order $first.Result $first.Preview) 'The first drop did not commit the last live preview order.'

  $secondTarget = if (Is-ImmediatelyBefore $first.Result '😮‍💨' '😭') { '😱' } else { '😭' }
  $second = Drag-Emoji $connection '😮‍💨' $secondTarget $false
  Assert-That ($second.Dragging -eq '😮‍💨') "The second long drag lost its active source before release (after press: $($second.ImmediateDragging); before release: $($second.Dragging))."
  Assert-That (-not (Same-Order $first.Result $second.Preview)) 'The second long drag did not reflow the palette.'
  Assert-That (Same-Order $second.Result $second.Preview) 'A second reorder required toggling reorder mode or did not commit.'
  $saved = @((Invoke-Js $connection 'JSON.stringify(window.__emojiPaletteOrderForTest ?? [])') | ConvertFrom-Json)
  Assert-That (Same-Order $saved $second.Result) 'The final order was not sent to persistent storage.'

  Invoke-Click $connection (Get-Point $connection '.emoji-reorder-toggle')
  $hiddenHandles = [int](Invoke-Js $connection 'document.querySelectorAll(".palette-drag-handle").length')
  Assert-That ($hiddenHandles -eq 0) "Expected no drag handles after leaving reorder mode, got $hiddenHandles."
  Invoke-Js $connection '(()=>{const textarea=document.querySelector(".composer-card > textarea");if(!textarea)throw new Error("text area missing");textarea.focus();const position=Math.floor(textarea.value.length/2);textarea.setSelectionRange(position,position);window.__emojiInsertionTest={before:textarea.value,position};})()' | Out-Null
  Scroll-Into-View $connection "[data-emoji='💋']"
  Invoke-Click $connection (Get-Point $connection "[data-emoji='💋']")
  $insertedAtCaret = Invoke-Js $connection '(()=>{const textarea=document.querySelector(".composer-card > textarea");const state=window.__emojiInsertionTest;return textarea.value===state.before.slice(0,state.position)+"💋"+state.before.slice(state.position);})()'
  Assert-That ($insertedAtCaret -eq $true) 'Emoji insertion did not use the text caret position after leaving reorder mode.'

  [pscustomobject]@{
    Passed = $true
    Handles = $handleCount
    FirstMove = "👂 after $firstTarget"
    SecondMove = "😮‍💨 before $secondTarget"
    CaretInsert = $insertedAtCaret
    FinalFirstFive = @($second.Result | Select-Object -First 5)
  } | ConvertTo-Json -Depth 4
} finally {
  $connection.Socket.Dispose()
  $connection.Cancellation.Dispose()
}
