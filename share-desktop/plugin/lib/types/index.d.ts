/** TidyWork 工作区插件 · 服务端半类型声明 */
export declare const name: "tidywork";
export declare const VERSION: string;
/** 只需要宿主的 webServer：在 /tidywork-api/* 下挂 REST 路由，不注册任何 UI 扩展点。 */
export declare const inject: readonly ["webServer"];
export declare function apply(ctx: any): void;
/** 仅测试用：纯函数导出，宿主不该依赖它。 */
export declare const __internals: Record<string, unknown>;
