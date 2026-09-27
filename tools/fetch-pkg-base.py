"""下载 pkg 预编译基础包（走 ghfast.top 镜像），支持断点续传与校验。"""
import urllib.request, hashlib, os, time, sys

CACHE = r"C:\Users\Administrator\.pkg-cache\v3.6"
NAME = "node-v22.23.2-win-x64"
BASE = "https://ghfast.top/https://github.com/yao-pkg/pkg-fetch/releases/download/v3.6/"
DST = os.path.join(CACHE, NAME)
PART = DST + ".part"


def fetch(url, headers=None, timeout=90):
    h = {"User-Agent": "Mozilla/5.0"}
    if headers:
        h.update(headers)
    return urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout)


def main():
    os.makedirs(CACHE, exist_ok=True)

    expected = None
    try:
        txt = fetch(BASE + NAME + ".sha256sum").read().decode().strip()
        expected = txt.split()[0]
        with open(DST + ".sha256sum", "w") as f:
            f.write(txt)
        print("期望 sha256:", expected, flush=True)
    except Exception as e:
        print("取 sha256 失败:", e, flush=True)

    for attempt in range(1, 8):
        have = os.path.getsize(PART) if os.path.exists(PART) else 0
        if os.path.exists(DST):
            break
        headers = {"Range": "bytes=%d-" % have} if have else None
        try:
            with fetch(BASE + NAME, headers) as r:
                total = int(r.headers.get("Content-Length") or 0) + have
                mode = "ab" if have else "wb"
                got = have
                t0 = time.time()
                with open(PART, mode) as f:
                    while True:
                        chunk = r.read(256 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if got // (10 * 1024 * 1024) != (got - len(chunk)) // (10 * 1024 * 1024):
                            print("  %dMB / %dMB  (%.1f MB/s)" % (
                                got // 1048576, total // 1048576, got / 1048576 / max(0.1, time.time() - t0)), flush=True)
            if total and os.path.getsize(PART) < total:
                print("第 %d 次未下完 (%d/%d)，继续续传…" % (attempt, os.path.getsize(PART), total), flush=True)
                time.sleep(2)
                continue
            os.replace(PART, DST)
            break
        except Exception as e:
            print("第 %d 次出错: %s" % (attempt, e), flush=True)
            time.sleep(2)

    if not os.path.exists(DST):
        print("下载失败", flush=True)
        return 1

    h = hashlib.sha256()
    with open(DST, "rb") as f:
        for b in iter(lambda: f.read(512 * 1024), b""):
            h.update(b)
    ok = (not expected) or h.hexdigest() == expected
    print("文件: %s  %dMB" % (DST, os.path.getsize(DST) // 1048576), flush=True)
    print("sha256:", h.hexdigest(), flush=True)
    print("校验:", "PASS" if ok else "FAIL", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
