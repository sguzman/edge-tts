using System;
using System.Linq;
using System.Speech.Synthesis;
using System.IO;
using System.Text.Json;

// Persistent x64 Native Messaging host. It deliberately uses SAPI/System.Speech;
// the adapter makes the compatible extracted Natural voice appear in that catalog.
internal static class WinNaturalHost
{
    private static readonly object Gate = new();
    private static SpeechSynthesizer? Synth;
    private static string? ActiveRequest;
    private static MemoryStream? Audio;

    private static void Send(object value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        lock (Gate)
        {
            using var stdout = Console.OpenStandardOutput();
            stdout.Write(BitConverter.GetBytes(bytes.Length));
            stdout.Write(bytes);
            stdout.Flush();
        }
    }

    private static SpeechSynthesizer GetSynth()
    {
        if (Synth != null) return Synth;
        Synth = new SpeechSynthesizer();
        Synth.SpeakProgress += (_, e) =>
        {
            var requestId = ActiveRequest;
            if (requestId == null) return;
            Send(new { type = "boundary", requestId, charIndex = e.CharacterPosition,
                length = e.CharacterCount, text = e.Text, audioPositionMs = e.AudioPosition.TotalMilliseconds });
        };
        Synth.SpeakCompleted += (_, e) =>
        {
            var requestId = ActiveRequest;
            if (requestId == null) return;
            if (e.Cancelled) Send(new { type = "cancelled", requestId });
            else if (e.Error != null) Send(new { type = "error", requestId, message = e.Error.Message });
            else
            {
                var data = Audio?.ToArray() ?? Array.Empty<byte>();
                for (var offset = 0; offset < data.Length; offset += 180_000)
                {
                    var count = Math.Min(180_000, data.Length - offset);
                    Send(new { type = "audioChunk", requestId, data = Convert.ToBase64String(data, offset, count) });
                }
                Send(new { type = "synthesisEnd", requestId });
            }
            ActiveRequest = null; Audio?.Dispose(); Audio = null;
        };
        return Synth;
    }

    private static void ListVoices(string requestId)
    {
        // NaturalVoiceSAPIAdapter exposes the compatible extracted Natural
        // voices with Local-* token IDs. Do not advertise ordinary SAPI
        // David/Mark/Zira voices through the WIN-NATURAL catalog.
        var voices = GetSynth().GetInstalledVoices()
            .Where(v => v.VoiceInfo.Id.StartsWith("Local-", StringComparison.OrdinalIgnoreCase))
            .Select(v => new {
            id = v.VoiceInfo.Id, name = v.VoiceInfo.Name, lang = v.VoiceInfo.Culture.Name
            }).ToArray();
        Send(new { type = "voices", requestId, voices });
    }

    private static void Synthesize(JsonElement message)
    {
        var requestId = message.GetProperty("requestId").GetString() ?? "";
        var voiceId = message.TryGetProperty("voiceId", out var id) ? id.GetString() : null;
        var text = message.GetProperty("text").GetString() ?? "";
        var synth = GetSynth();
        if (ActiveRequest != null) throw new InvalidOperationException("The Windows Natural helper is already synthesizing.");
        if (!string.IsNullOrWhiteSpace(voiceId))
        {
            var installed = synth.GetInstalledVoices().FirstOrDefault(v => v.VoiceInfo.Id.Equals(voiceId, StringComparison.OrdinalIgnoreCase));
            if (installed == null) throw new InvalidOperationException("The requested SAPI voice is not installed: " + voiceId);
            synth.SelectVoice(installed.VoiceInfo.Name);
        }
        ActiveRequest = requestId;
        Audio = new MemoryStream();
        synth.SetOutputToWaveStream(Audio);
        var requestedRate = message.TryGetProperty("rate", out var rate) ? rate.GetDouble() : 1.0;
        synth.Rate = Math.Clamp((int)Math.Round((requestedRate - 1.0) * 10), -10, 10);
        try { synth.SpeakAsync(text); }
        catch
        {
            ActiveRequest = null;
            Audio.Dispose();
            Audio = null;
            throw;
        }
    }

    public static void Main()
    {
        Console.InputEncoding = System.Text.Encoding.UTF8;
        using var stdin = Console.OpenStandardInput();
        var lengthBytes = new byte[4];
        while (true)
        {
            try { stdin.ReadExactly(lengthBytes, 0, 4); } catch (EndOfStreamException) { break; }
            var length = BitConverter.ToInt32(lengthBytes, 0);
            if (length <= 0 || length > 16 * 1024 * 1024) continue;
            var payload = new byte[length];
            stdin.ReadExactly(payload, 0, length);
            using var document = JsonDocument.Parse(payload);
            var message = document.RootElement;
            var type = message.TryGetProperty("type", out var typeElement) ? typeElement.GetString() : "";
            var requestId = message.TryGetProperty("requestId", out var requestElement) ? requestElement.GetString() ?? "" : "";
            try
            {
                if (type == "hello") Send(new { type = "hello", protocol = 1, architecture = "x64" });
                else if (type == "voices") ListVoices(requestId);
                else if (type == "synthesize") Synthesize(message);
                else if (type == "cancel") GetSynth().SpeakAsyncCancelAll();
            }
            catch (Exception error) { Send(new { type = "error", requestId, message = error.Message }); }
        }
    }
}
