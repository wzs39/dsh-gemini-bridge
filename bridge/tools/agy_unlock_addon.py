r"""
mitmproxy addon: 绕过 Antigravity (agy) CLI 的地区资格检查。

原理（本机实测，见 probe-agy-upstream.ps1 -> HTTP 200）
------------------------------------------------------
地区锁在客户端：CLI 调 POST /v1internal:loadCodeAssist，读到拒绝语义
（ineligibleTiers 里的 UNSUPPORTED_LOCATION / ineligibleReason）就自己拒启动
（server_oauth.go: "Account ineligible: ... not currently available in your
location."）。同一账号同一 token 直接打 streamGenerateContent，后端返回 200。

本 addon 拦两条元数据端点的【应答】做最小改写，其余流量（含模型生成）原样透传：

  loadCodeAssist        -- 删 ineligibleTiers / ineligibleReason 拒绝字段；
                           currentTier/allowedTiers/project 保留真实应答原值
                           （实测 standard-tier 本来就被授予，不需要伪造）。
  retrieveUserQuotaSummary
                        -- 若被 VALIDATION_REQUIRED 等 403 拒绝：先存档，再换
                           一份结构最简的 200 应答。quota 不参与生成鉴权
                           （探针不查 quota 也能拿到补全），改写它只为让 CLI
                           不在启动路径上被这道锁卡死。

用法（Windows，一次性）
-----------------------
1) pip install mitmproxy
2) 起代理（首次自动在 ~/.mitmproxy 生成 CA）：
     mitmdump -s agy_unlock_addon.py --listen-port 8899 --quiet
3) 信任 mitm CA（Go 走 Windows 系统证书库，装 CurrentUser 即可，无需管理员）：
     certutil -addstore -user Root "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer"
   或浏览器（代理已起时）打开 http://mitm.it 下载安装。
4) 只让 agy 走代理（推荐 wrapper 脚本 agy-unlock.cmd，本目录自带）；
   手动等价：
     set HTTPS_PROXY=http://127.0.0.1:8899
     agy
5) 验证与回滚：agy 正常出模型即生效；关掉 mitmdump / 去掉环境变量就回到
   原生行为，不留任何持久改动（除了证书，可在证书管理器删除 mitmproxy 项）。

原始应答全部存档在本目录 agy-response-dump/ ——Google 改字段名时按真实结构
微调下面的改写段即可，不要凭猜扩展。

注意：validation_url 的 VALIDATION_REQUIRED 是 Google 账号验证（另一道锁），
addon 只兜住 CLI 启动路径；账号验证仍建议人工过一次（点 CLI 日志里的
validation_url），否则上游哪天把验证扩到生成端点，addon 不该也不能替你过。
"""

import json
import os
import time

from mitmproxy import http

DUMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agy-response-dump")

TARGET_HOST = "daily-cloudcode-pa.googleapis.com"
ELIGIBILITY_PATH = "/v1internal:loadCodeAssist"
QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary"

REJECT_FIELDS = ("ineligibleReason", "ineligible_reason", "ineligibleTiers")


def _dump(flow: http.HTTPFlow, tag: str) -> None:
    """保留原始应答：Google 改结构时对照微调，也作为可复核证据。"""
    try:
        os.makedirs(DUMP_DIR, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        with open(os.path.join(DUMP_DIR, f"{stamp}_{tag}_{flow.response.status_code}.json"), "wb") as fh:
            fh.write(flow.response.content or b"")
    except OSError:
        pass


def _dump_fields(data: dict) -> None:
    """passthrough 存档只记字段名与状态，不落应答值，dump 目录可放心提交。"""
    try:
        os.makedirs(DUMP_DIR, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        with open(os.path.join(DUMP_DIR, f"{stamp}_eligibility-seen_200.json"), "wb") as fh:
            fh.write(json.dumps({"fields": sorted(data.keys())}).encode("utf-8"))
    except OSError:
        pass


def _json_body(resp):
    try:
        data = json.loads(resp.content.decode("utf-8"))
        return data if isinstance(data, dict) else None
    except (ValueError, UnicodeDecodeError):
        return None


def _rewrite_json(flow: http.HTTPFlow, data: dict) -> None:
    body = json.dumps(data).encode("utf-8")
    flow.response.status_code = 200
    flow.response.content = body
    flow.response.headers["content-length"] = str(len(body))


def response(flow: http.HTTPFlow) -> None:
    if TARGET_HOST not in (flow.request.host or ""):
        return
    if flow.response is None:
        return

    path = flow.request.path or ""

    if path.startswith(ELIGIBILITY_PATH):
        data = _json_body(flow.response)
        if data is None:
            _dump(flow, "eligibility-broken")
            return
        # 无条件存档一条 passthrough 记录（只带字段名，不带值），
        # 用于证明 addon 确实在链路上；改写仍只在有拒绝语义时发生。
        _dump_fields(data)
        # 只在真有拒绝语义时改写，正常应答原样过（少碰一次就少一分漂移）。
        touched = False
        for field in REJECT_FIELDS:
            if field in data:
                data.pop(field)
                touched = True
        if data.get("state") not in (None, "ACTIVE"):
            data["state"] = "ACTIVE"
            touched = True
        if touched:
            _dump(flow, "eligibility-orig")
            _rewrite_json(flow, data)

    elif path.startswith(QUOTA_PATH) and flow.response.status_code != 200:
        data = _json_body(flow.response)
        reason = ""
        try:
            reason = data["error"]["details"][0]["reason"]
        except (TypeError, KeyError, IndexError):
            pass
        _dump(flow, "quota-blocked")
        # 只兜 VALIDATION_REQUIRED / 403；429 是真实配额，不伪造（伪造了
        # 也躲不过生成端点的真实限流，不如让 CLI 自己显示）。
        if flow.response.status_code == 403 or reason == "VALIDATION_REQUIRED":
            _rewrite_json(flow, {
                "monthlyQuotaExpiresTime": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400 * 28)
                ),
                "models": {},
            })
