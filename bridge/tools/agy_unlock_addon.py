"""
mitmproxy addon: 伪造 Antigravity (agy) CLI 的 eligibility 应答，绕过地区资格检查。

原理
----
agy 启动时向 https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
发 POST，后端依据【账号归属地】返回 ineligibleReason=REGION_UNAVAILABLE 之类字段，
server_oauth.go 看到它就直接拒绝（"not currently available in your location"）。
本 addon 拦下这条响应、按真实结构改写，让客户端认为账号有资格；其余流量原样透传。

用法（Windows，一次性）
-----------------------
1) pip install mitmproxy
2) 起代理（首次会自动生成 CA）：
     mitmdump -s agy_unlock_addon.py --listen-port 8899 --quiet
3) 信任 mitm CA（Go 走 Windows 系统证书库，装到 CurrentUser 即可）：
   浏览器打开 http://mitm.it（代理已起时）下载证书，或：
     certutil -addstore -user Root "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer"
4) 让 agy 走代理（同一终端）：
     set HTTPS_PROXY=http://127.0.0.1:8899
     set HTTP_PROXY=http://127.0.0.1:8899
     set NO_PROXY=localhost,127.0.0.1
     agy
5) 若 loadCodeAssist 改写后模型调用仍被 403（后端也查），看本目录
   agy-response-dump/ 里存下的真实响应体，按实际字段名微调改写段。

注意：validation_url 的 VALIDATION_REQUIRED 是另一道锁（Google 账号验证），
本 addon 不解决也不应解决——先点验证链接过掉它，否则 quota 接口永远 403。
"""

import json
import os
import time

from mitmproxy import http

DUMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agy-response-dump")

TARGET_HOST = "daily-cloudcode-pa.googleapis.com"
ELIGIBILITY_PATH = "/v1internal:loadCodeAssist"
QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary"

# 伪装成受支持地区。芬兰=你当前实际所在国，与出口 IP 一致，最不容易穿帮。
SPOOF_REGION = "FI"
SPOOF_TIER = "antigravity-pro-tier"          # 你有两份 AI Pro 订阅，按 Pro 伪装
SPOOF_PROJECT = "agy-unlock-local"


def _dump(flow: http.HTTPFlow, body: bytes) -> None:
    """保留原始应答，方便后端改字段后对照微调。"""
    try:
        os.makedirs(DUMP_DIR, exist_ok=True)
        name = flow.request.path.lstrip("/").replace(":", "_").replace("/", "_")
        stamp = time.strftime("%Y%m%d_%H%M%S")
        with open(os.path.join(DUMP_DIR, f"{stamp}_{name}.json"), "wb") as fh:
            fh.write(body)
    except OSError:
        pass


def response(flow: http.HTTPFlow) -> None:
    if TARGET_HOST not in (flow.request.host or ""):
        return
    if flow.response is None or flow.response.status_code != 200:
        # 错误应答先存档再放行；403 需要人工看是否 VALIDATION_REQUIRED
        if flow.response is not None and flow.request.path in (
            ELIGIBILITY_PATH,
            QUOTA_PATH,
        ):
            _dump(flow, flow.response.content or b"")
        return

    if flow.request.path == ELIGIBILITY_PATH:
        _dump(flow, flow.response.content)
        try:
            data = json.loads(flow.response.content.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return

        # 三道保险：删资格拒绝字段、注入已 onboard 状态、伪造地区与 tier
        data.pop("ineligibleReason", None)
        data.pop("ineligible_reason", None)     # proto3 JSON 两种拼写都出现过
        data["onboardingComplete"] = True
        data["state"] = "ACTIVE"
        region = data.setdefault("cloudaicompanionRegion", {})
        region["regionCode"] = SPOOF_REGION
        tier = {
            "id": SPOOF_TIER,
            "name": f"{SPOOF_TIER}/projects/{SPOOF_PROJECT}",
            "description": "Antigravity Pro",
            "isDefaultTier": True,
        }
        data["currentTier"] = tier
        allowed = data.setdefault("allowedTiers", [])
        if not any(isinstance(t, dict) and t.get("id") == SPOOF_TIER for t in allowed):
            allowed.insert(0, tier)
        project = data.setdefault("project", {})
        project.setdefault("name", SPOOF_PROJECT)
        project.setdefault("projectId", SPOOF_PROJECT)

        flow.response.content = json.dumps(data).encode("utf-8")
        flow.response.headers["content-length"] = str(len(flow.response.content))

    elif flow.request.path == QUOTA_PATH:
        # quota 接口对 Pro 伪装补一份合理额度；原始 403 已被上面 dump。
        try:
            data = json.loads(flow.response.content.decode("utf-8"))
            if "models" in data or "monthlyQuotaExpiresTime" in data:
                return  # 本来就是正常结构，原样放行
        except (ValueError, UnicodeDecodeError):
            pass
        _dump(flow, flow.response.content)
        spoofed = {
            "monthlyQuotaExpiresTime": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400 * 28)
            ),
            "models": {},
        }
        flow.response.status_code = 200
        flow.response.content = json.dumps(spoofed).encode("utf-8")
        flow.response.headers["content-length"] = str(len(flow.response.content))
