$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$synth = $null
$stream = $null
try {
  $raw = [Console]::In.ReadToEnd()
  if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 16384) { throw 'invalid request' }
  $request = $raw | ConvertFrom-Json
  if ($request.action -ne 'catalog' -and $request.action -ne 'synthesize') { throw 'invalid action' }
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $installed = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name.Length -le 240 })
  if ($request.action -eq 'catalog') {
    $defaultName = $synth.Voice.Name
    $voices = @($installed | Sort-Object @{Expression={ if ($_.VoiceInfo.Name -ceq $defaultName) { 0 } else { 1 } }} | Select-Object -First 32 | ForEach-Object {
      [ordered]@{ id=('win-sapi:' + $_.VoiceInfo.Name); name=$_.VoiceInfo.Name; lang=$_.VoiceInfo.Culture.Name; default=($_.VoiceInfo.Name -ceq $defaultName) }
    })
    [ordered]@{ status='available'; voices=$voices } | ConvertTo-Json -Depth 5 -Compress
  } else {
    if ($request.text -isnot [string] -or [string]::IsNullOrWhiteSpace($request.text) -or $request.text.Length -gt 4000 -or $request.voiceName -isnot [string] -or
      $request.sapiRate -lt -10 -or $request.sapiRate -gt 10 -or $request.sapiRate -ne [int]$request.sapiRate -or $request.maxBytes -ne 8388608) { throw 'invalid request' }
    $voice = @($installed | Where-Object { $_.VoiceInfo.Name -ceq $request.voiceName })
    if ($voice.Count -ne 1) { throw 'unavailable voice' }
    $output = [IO.Path]::GetFullPath([string]$request.path)
    if ([IO.Path]::GetFileName($output) -notmatch '^xiangxu-speech-[0-9a-f-]{36}\.wav\.part$') { throw 'invalid output' }
    $directory = [IO.Path]::GetDirectoryName($output)
    $cursor = New-Object IO.DirectoryInfo($directory)
    while ($null -ne $cursor) { if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe output' }; $cursor = $cursor.Parent }
    $info = Get-Item -LiteralPath $output
    if ($info.Length -ne 0 -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe output' }
    $leasePath = [IO.Path]::Combine($directory, 'windows-speech.lock')
    $leaseInfo = Get-Item -LiteralPath $leasePath
    if ($leaseInfo.Length -gt 2048 -or ($leaseInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe lease' }
    $lease = [IO.File]::ReadAllText($leasePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($lease.schemaVersion -ne 'xiangxu-windows-speech-cache/1' -or $lease.token -cne $request.cacheToken) { throw 'invalid lease' }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
public sealed class XiangxuBoundedWaveStream : Stream {
  readonly FileStream inner;
  readonly long maximum;
  public XiangxuBoundedWaveStream(string path, long maximum) {
    this.maximum = maximum;
    inner = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read);
  }
  public override bool CanRead { get { return inner.CanRead; } }
  public override bool CanSeek { get { return true; } }
  public override bool CanWrite { get { return true; } }
  public override long Length { get { return inner.Length; } }
  public override long Position { get { return inner.Position; } set { if(value < 0 || value > maximum) throw new IOException("capacity"); inner.Position = value; } }
  public override void Flush() { inner.Flush(); }
  public override int Read(byte[] buffer, int offset, int count) { return inner.Read(buffer, offset, count); }
  public override long Seek(long offset, SeekOrigin origin) {
    long position = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? Position + offset : Length + offset;
    if(position < 0 || position > maximum) throw new IOException("capacity");
    return inner.Seek(offset, origin);
  }
  public override void SetLength(long length) { if(length < 0 || length > maximum) throw new IOException("capacity"); inner.SetLength(length); }
  public override void Write(byte[] buffer, int offset, int count) {
    if(count < 0 || Position > maximum - count) throw new IOException("capacity");
    inner.Write(buffer, offset, count);
  }
  protected override void Dispose(bool disposing) { if(disposing) inner.Dispose(); base.Dispose(disposing); }
}
'@
    $stream = New-Object XiangxuBoundedWaveStream($output, 8388608)
    $synth.SelectVoice($voice[0].VoiceInfo.Name)
    $synth.Rate = [int]$request.sapiRate
    $synth.SetOutputToWaveStream($stream)
    $synth.Speak([string]$request.text)
    $synth.SetOutputToNull()
    $stream.Flush()
    $length = $stream.Length
    $stream.Dispose(); $stream = $null
    [ordered]@{ status='generated'; bytes=$length } | ConvertTo-Json -Compress
  }
} catch {
  # Text, engine exceptions and credentials are never echoed to stdout/stderr.
  [ordered]@{ status='unavailable'; reason='system_speech_unavailable' } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $synth) { $synth.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
}
