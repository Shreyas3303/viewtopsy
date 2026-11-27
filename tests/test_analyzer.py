import pytest

from stream_moments.analyzer import SENSITIVITY, build_timeline, find_moments
from stream_moments.chat import parse_timestamp
from stream_moments.models import ChatMessage


def quiet_stream(minutes: int = 10, every: float = 15.0) -> list[ChatMessage]:
    return [ChatMessage(timestamp=t * every, text="quiet chat", author=f"user{t % 9}") for t in range(int(minutes * 60 / every))]


def burst(start: float, count: int, text: str = "INSANE play", spread: float = 1.0) -> list[ChatMessage]:
    return [ChatMessage(timestamp=start + i * spread, text=text, author=f"fan{i}") for i in range(count)]


def test_parse_timestamp_formats():
    assert parse_timestamp("01:02:03") == 3723
    assert parse_timestamp("2:05") == 125
    assert parse_timestamp("PT1M2.5S") == 62.5
    assert parse_timestamp(12) == 12.0


def test_finds_a_chat_spike():
    messages = [ChatMessage(timestamp=float(index * 15), text="quiet") for index in range(8)]
    messages += [ChatMessage(timestamp=60 + offset, text="INSANE play") for offset in range(8)]
    moments = find_moments(messages, window_seconds=15, z_threshold=1, min_messages=4)
    assert len(moments) == 1
    assert moments[0].peak_time == 60
    assert moments[0].timestamp == 45  # one window early, to catch the build-up
    assert "insane" in moments[0].keywords


def test_back_to_back_windows_merge_into_one_moment():
    messages = quiet_stream() + burst(300, 40, spread=0.75)  # 30 seconds of hype = two 15s windows
    moments = find_moments(messages, window_seconds=15, z_threshold=2, min_messages=5)
    assert len(moments) == 1
    assert moments[0].window_start == 300
    assert moments[0].window_end == 330
    assert moments[0].message_count == 40 + 2  # plus two quiet messages in those windows


def test_ranks_bigger_spike_first():
    messages = quiet_stream(20) + burst(200, 15, "nice") + burst(900, 40, "NO WAY")
    moments = find_moments(messages, window_seconds=15, z_threshold=1.5)
    assert [m.peak_time for m in moments] == [900, 195]
    assert moments[0].intensity > moments[1].intensity


def test_sensitivity_controls_how_many_moments():
    messages = quiet_stream(20) + burst(200, 9, "ok") + burst(600, 14, "nice") + burst(900, 40, "NO WAY")
    low = find_moments(messages, z_threshold=SENSITIVITY["low"])
    high = find_moments(messages, z_threshold=SENSITIVITY["high"])
    assert len(low) < len(high)


def test_keywords_count_each_message_once():
    spammer = [ChatMessage(timestamp=300 + i * 0.1, text="spam spam spam spam", author="bot") for i in range(3)]
    crowd = burst(301, 10, "clutch")
    moments = find_moments(quiet_stream() + spammer + crowd, z_threshold=1)
    assert moments[0].keywords[0] == "clutch"
    assert moments[0].unique_chatters == 12  # 10 fans + the spammer + one quiet regular


def test_keywords_need_more_than_one_message():
    messages = quiet_stream() + burst(300, 12, "BOSS DOWN") + [ChatMessage(301, "random tangent")]
    keywords = find_moments(sorted(messages, key=lambda m: m.timestamp), z_threshold=1)[0].keywords
    assert keywords == ["boss", "down"]


def test_samples_prefer_on_topic_messages():
    # The quiet regular and the off-topic question both come before the hype.
    messages = quiet_stream() + [ChatMessage(300.2, "what game is this")] + burst(301, 20, "BOSS DOWN", spread=0.5)
    sample = find_moments(sorted(messages, key=lambda m: m.timestamp), z_threshold=1)[0].sample_messages
    assert sample == ["BOSS DOWN", "quiet chat", "what game is this"]


def test_no_messages_and_flat_chat():
    assert find_moments([]) == []
    assert find_moments(quiet_stream()) == []  # steady chat has no spikes


def test_rejects_bad_settings():
    with pytest.raises(ValueError):
        find_moments(quiet_stream(), window_seconds=0)
    with pytest.raises(ValueError):
        find_moments(quiet_stream(), min_messages=0)


def test_build_timeline():
    assert build_timeline([ChatMessage(0, "a"), ChatMessage(14, "b"), ChatMessage(31, "c")], 15) == [2, 0, 1]
