# 解锁链路常驻化补丁

本补丁不修改 `agy_unlock_addon.py`，也不改 `agy-unlock.cmd`。它补的是那两者
**之外**缺的一层：让解锁代理真正活着，并且真的被 agy 用上。

## 为什么需要这个补丁

仓库里 `agy_unlock_addon.py` 一直是对的，但它只在 mitmproxy 监听器活着时有
作用。实际失效几乎从来不是 addon 写错了，而是：

1. **监听器没在跑**。机器重启、进程被杀、任务没注册——任何一次都会让它消失。
   此时 agy 直接走裸出口，CLI 吐出原始地区墙，报错和「addon 无效」一模一样。
2. **代理没被注入到 agy 进程**。手动用 `agy-unlock.cmd` 包一层是好的，但 DSH
   通过 `dsh-agy-link` 拉起 agy 时不经过那个 wrapper。插件实际这样拼环境：

   ```js
   const effectiveProxy = account?.proxyUrl || cfg.proxyUrl || detectSystemProxy() || void 0;
   const env = { ...process.env, ...proxyEnvFor(effectiveProxy) };
   ```

   所以持久化的杠杆是 `pool.json` 里每个账号的 `proxyUrl`；只起代理不改它，
   DSH 拉起的 agy 依然裸奔。

这两件事合起来，就是「明明有 addon，在 DSH 里选 Antigravity 模型还是报地区
限制」的完整原因。本补丁把两处都封上。

## 组成

| 文件 | 作用 |
|---|---|
| `unlock-keepalive.ps1` | 幂等守护：端口没监听就拉起 mitmdump，等它真的可连再退出 |
| `unlock-install.ps1` | 注册计划任务（登录后 1 分钟 + 每 10 分钟），无需管理员 |
| `set-pool-proxy.py` | 给 pool.json 每个账号写 `proxyUrl`；默认 dry-run，`--clear` 可撤销 |
| `unlock-verify.ps1` | 分四段独立验证链路，`-LiveTest` 跑一次真实生成 |

拆开是有意的：守护、注入、验证三种失败模式互相独立，合在一个脚本里出错时
分不清是哪一层。

## 用法

```powershell
cd bridge/tools

# 1. 起代理并注册自愈（无需管理员）
powershell -ExecutionPolicy Bypass -File .\unlock-install.ps1

# 2. 把代理写进每个 agy 账号（先看 dry-run，确认后再 --apply）
python set-pool-proxy.py
python set-pool-proxy.py --apply

# 3. 验证（-LiveTest 会真的生成一次，是最硬的证据）
powershell -ExecutionPolicy Bypass -File .\unlock-verify.ps1 -LiveTest
```

宿主级兜底（可选，pool.json 被重置时仍有代理）：

```powershell
[Environment]::SetEnvironmentVariable('DSH_AGY_PROXY_URL','http://127.0.0.1:8899','User')
```

改完需要**重启 DSH**，插件才会重新读 pool.json。

## 前提

- `pip install mitmproxy`，且 mitm CA 已进 `CurrentUser\Root`。
  `agy-unlock.cmd` 首次运行会自动装 CA，也可以手动：
  `certutil -addstore -user Root "%USERPROFILE%\.mitmproxy\mitmproxy-ca-cert.cer"`
- `agy` 已登录（`~/.gemini/antigravity-cli/` 或 Windows 凭据管理器里有凭据）。

## 撤销

```powershell
# 去掉 pool.json 的 proxyUrl（插件随之回到直连）
python set-pool-proxy.py --clear --apply

# 注销自愈任务
powershell -ExecutionPolicy Bypass -File .\unlock-install.ps1 -Uninstall

# 停监听器
Get-Process mitmdump | Stop-Process -Force

# 想连证书一起清掉
Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -match 'mitmproxy' } |
  ForEach-Object { $s = New-Object Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser'); $s.Open('ReadWrite'); $s.Remove($_); $s.Close() }
```

`set-pool-proxy.py` 每次写入前都会在同目录留 `pool.json.bak-<时间戳>`。

## 边界（与主 README 一致，别混淆两道墙）

本补丁只解决**客户端误判**那一道：

| `loadCodeAssist` | `streamGenerateContent` | 本补丁有用吗 |
|---|---|---|
| 200，带 `UNSUPPORTED_LOCATION` | **200** | **有用**——抹掉拒绝字段即可 |
| 200，带 `UNSUPPORTED_LOCATION` | **403 `VALIDATION_REQUIRED`** | **没用**——那是 Google 账号验证，只能人工过 |

第二种情况先用 `node bridge/tools/fix-validation.mjs <账号>` 拿到验证链接，用该账号
本人的独立 profile 完成验证。别把它当地区问题反复折腾。

`-LiveTest` 返回 200 就是第一类；返回 403 `VALIDATION_REQUIRED` 就是第二类，
此时本补丁无论怎么配都不会通——那不是配置问题。

## 实测记录（本机 `agy` 1.4.10）

补丁生效前：

```
error: Eligibility check failed: Your current account is not eligible for
Antigravity, because it is not currently available in your location.
```

补丁生效后，用插件真实注入的环境变量组合（隔离 HOME + `proxyEnvFor` 六个变量）
跑一次生成：

```json
{"status":"SUCCESS","response":"391\n","duration_seconds":2.97,
 "usage":{"input_tokens":8113,"output_tokens":170,"thinking_tokens":167,"total_tokens":8283}}
```

自愈也实测过：`Stop-Process mitmdump` 后触发任务，1 秒内重新监听 8899。
