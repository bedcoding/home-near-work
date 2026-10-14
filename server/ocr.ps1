# 그림으로 된 PDF의 글자를 윈도우 기본 기능으로 읽는다(ocr.ts가 -EncodedCommand로 실행).
# 입력: 환경 변수 HNW_OCR_PDF(PDF 파일 경로), HNW_OCR_PAGES(읽을 쪽 수 상한).
# 출력(UTF-8, 한 줄에 하나, 칸은 탭): 'P 쪽번호 그림너비 그림높이', 그 쪽에서 인식한 낱말마다 'W 글자 x y 너비 높이'.
# 한국어 인식기가 없으면 'E no-ko' 한 줄.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$tab = [char]9
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAction($op) { $t = $asTaskAct.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ko'))
if ($null -eq $engine) { Write-Output "E${tab}no-ko"; exit 0 }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:HNW_OCR_PDF)) ([Windows.Storage.StorageFile])
$doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$n = [Math]::Min([int]$doc.PageCount, [int]$env:HNW_OCR_PAGES)
for ($i = 0; $i -lt $n; $i++) {
  $page = $doc.GetPage([uint32]$i)
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  # 기본 크기로 그리면 글자가 작아 숫자를 잘못 읽는다. 너비는 화면 배율이 곱해진 값이라 배율 175%에서 3850px쯤.
  $opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $opt.DestinationWidth = [uint32]2200
  AwaitAction ($page.RenderToStreamAsync($stream, $opt))
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  Write-Output "P${tab}${i}${tab}$($bmp.PixelWidth)${tab}$($bmp.PixelHeight)"
  foreach ($line in $res.Lines) {
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      Write-Output ("W$tab{0}$tab{1}$tab{2}$tab{3}$tab{4}" -f $w.Text, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
    }
  }
  $bmp.Dispose(); $stream.Dispose(); $page.Dispose()
}
