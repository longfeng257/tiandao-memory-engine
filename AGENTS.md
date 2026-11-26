# GitHub 推送网络回退

当常规 `git fetch` / `git push` 因本机代理或默认路由连不上 GitHub 时，按以下步骤回退；不要直接认定网络整体不可用。

1. 从 GitHub 官方 Meta API (`https://api.github.com/meta`) 获取**当前** `web` IPv4 地址范围，不要把某次使用的 IP 永久写死。
2. 从官方 `web` 范围中逐个选取候选地址，用 `curl.exe --noproxy "*" --resolve github.com:443:<IP> ...` 测试 HTTPS 连通性；只使用实际返回有效 HTTP 响应的地址。
3. 先用相同的临时配置读取远端分支，确认远端基线和本地提交关系；再进行推送：

   ```powershell
   git -c http.proxy= -c http.curloptResolve=github.com:443:<可用IP> -c protocol.version=1 ls-remote origin refs/heads/main
   git -c http.proxy= -c http.curloptResolve=github.com:443:<可用IP> -c protocol.version=1 push origin main
   ```

4. `protocol.version=1` 是回退选项：若协议 v2 出现空响应，可用 v1 重试。不要关闭 TLS 证书验证、不要改写全局 Git 代理配置，也不要 force-push。若远端已领先或官方 IP 均不可用，先停止并处理对应问题。

该配置只对单条 Git 命令生效；远端认证仍使用现有 Git 凭据。
