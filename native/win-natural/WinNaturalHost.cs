using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;
using System.Speech.Synthesis;
using System.Text.Json;

// Gate 1 transport-only host. The existing adapter exposes the extracted
// Natural voice as a Local-* SAPI voice; this host only handshakes/enumerates.
internal static class WinNaturalHost
{
    private const int MaxMessageBytes = 16 * 1024 * 1024;
    private static readonly object OutputGate = new();
    private static readonly Stream Output = Console.OpenStandardOutput();
    private static SpeechSynthesizer? Synthesizer;

    private static SpeechSynthesizer GetSynthesizer() => Synthesizer ??= new SpeechSynthesizer();

    private static void Send(object message)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message);
        if (payload.Length > MaxMessageBytes) throw new InvalidOperationException("Native response is too large.");
        Span<byte> header = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(header, payload.Length);
        lock (OutputGate)
        {
            Output.Write(header);
            Output.Write(payload);
            Output.Flush();
        }
    }

    private static bool TryReadExactly(Stream input, Span<byte> buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = input.Read(buffer[offset..]);
            if (read == 0) return false;
            offset += read;
        }
        return true;
    }

    private static object EnumerateVoices(string requestId)
    {
        var voices = GetSynthesizer().GetInstalledVoices()
            .Where(voice => voice.VoiceInfo.Id.StartsWith("Local-", StringComparison.OrdinalIgnoreCase))
            .Select(voice => new
            {
                id = voice.VoiceInfo.Id,
                name = voice.VoiceInfo.Name,
                lang = voice.VoiceInfo.Culture.Name
            })
            .ToArray();
        return new { type = "voices", requestId, architecture = "x64", voices };
    }

    private static void Handle(JsonElement message)
    {
        var type = message.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : "";
        var requestId = message.TryGetProperty("requestId", out var idValue) ? idValue.GetString() ?? "" : "";
        switch (type)
        {
            case "hello":
                Send(new { type = "hello", requestId, protocol = 1, architecture = "x64" });
                break;
            case "voices":
                Send(EnumerateVoices(requestId));
                break;
            default:
                Send(new { type = "error", requestId, message = $"Unsupported request type: {type}" });
                break;
        }
    }

    public static void Main()
    {
        using var input = Console.OpenStandardInput();
        Span<byte> header = stackalloc byte[4];
        while (TryReadExactly(input, header))
        {
            var length = BinaryPrimitives.ReadInt32LittleEndian(header);
            if (length <= 0 || length > MaxMessageBytes)
            {
                Send(new { type = "error", requestId = "", message = "Invalid Native Messaging frame length." });
                break;
            }

            var payload = new byte[length];
            if (!TryReadExactly(input, payload)) break;
            try
            {
                using var document = JsonDocument.Parse(payload);
                Handle(document.RootElement);
            }
            catch (Exception error)
            {
                Send(new { type = "error", requestId = "", message = error.Message });
            }
        }
    }
}
