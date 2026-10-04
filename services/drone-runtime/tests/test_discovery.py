from ember_drone_runtime.link.discovery import edge_url


def test_edge_url_from_announcement() -> None:
    txt: dict[bytes, bytes | None] = {b"id": b"edge-1", b"path": b"/v1/drone"}
    assert edge_url(["192.168.1.20"], 8070, txt, None) == "ws://192.168.1.20:8070/v1/drone"
    assert edge_url(["192.168.1.20"], 8070, txt, "edge-1") == "ws://192.168.1.20:8070/v1/drone"


def test_edge_url_prefers_ipv4_and_brackets_ipv6() -> None:
    txt: dict[bytes, bytes | None] = {b"id": b"edge-1"}
    both = ["fd00::5", "10.0.0.5"]
    assert edge_url(both, 9000, txt, None) == "ws://10.0.0.5:9000/v1/drone"
    assert edge_url(["fd00::5"], 9000, txt, None) == "ws://[fd00::5]:9000/v1/drone"


def test_edge_url_skips_unusable_or_other_edges() -> None:
    txt: dict[bytes, bytes | None] = {b"id": b"edge-1"}
    assert edge_url(["10.0.0.5"], 8070, txt, "edge-2") is None
    assert edge_url([], 8070, txt, None) is None
    assert edge_url(["10.0.0.5"], None, txt, None) is None
