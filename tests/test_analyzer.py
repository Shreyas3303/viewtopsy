from stream_moments.analyzer import find_moments
from stream_moments.chat import parse_timestamp
from stream_moments.models import ChatMessage


def test_parse_timestamp_formats():
    assert parse_timestamp("01:02:03") == 3723
    assert parse_timestamp("PT1M2.5S") == 62.5


def test_finds_a_chat_spike():
    messages = [ChatMessage(timestamp=float(index * 15), text="quiet") for index in range(8)]
    messages += [ChatMessage(timestamp=60 + offset, text="INSANE play") for offset in range(8)]
    moments = find_moments(messages, window_seconds=15, z_threshold=1, min_messages=4)
    assert len(moments) == 1
    assert moments[0].timestamp == 67.5
    assert "insane" in moments[0].keywords
