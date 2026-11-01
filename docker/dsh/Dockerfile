# DSH 容器：DeepSeek Harness（dsh web）
FROM node:22

# 全局安装 DSH（与 TidyWork 虚拟机内 .nvm node v22 同主版本）
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @deepseek-ai/dsh

# token 日志目录（compose 中挂载宿主机 /Users/guosy/Documents/TidyWork/dsh-log，
# TidyWork 容器读取解析 token）
RUN mkdir -p /dsh-log

EXPOSE 3080

# dsh web 只允许绑定具体 IP（拒绝通配符），容器 IP 每次启动可能变化，
# 因此动态取本容器 IP 绑定；--trusted-host 放行 TidyWork 容器经
# http://dsh:3080 访问的 Host/Origin 信任校验。
# 启动方式与 TidyWork 虚拟机 systemd 单元一致：dsh web --no-open，
# stdout 重定向到共享日志（token 输出到 stdout）。
CMD ["/bin/bash", "-lc", "HOST_IP=$(hostname -i | awk '{print $1}') && echo \"DSH_BIND=$HOST_IP\" && exec dsh web --host $HOST_IP --no-open --trusted-host dsh:3080 > /dsh-log/dsh-web.log 2>&1"]
