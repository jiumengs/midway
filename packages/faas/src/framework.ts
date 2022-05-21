import {
  FaaSContext,
  IFaaSConfigurationOptions,
  IMidwayFaaSApplication,
} from './interface';
import {
  BaseFramework,
  ContextMiddlewareManager,
  FunctionMiddleware,
  IMidwayBootstrapOptions,
  MidwayEnvironmentService,
  MidwayFrameworkType,
  MidwayMiddlewareService,
  RouterInfo,
  ServerlessTriggerCollector,
  initializeGlobalApplicationContext,
  pathToRegexp,
} from '@midwayjs/core';
import {
  Framework,
  Inject,
  WEB_RESPONSE_CONTENT_TYPE,
  WEB_RESPONSE_HEADER,
  WEB_RESPONSE_HTTP_CODE,
  WEB_RESPONSE_REDIRECT,
} from '@midwayjs/decorator';
import SimpleLock from '@midwayjs/simple-lock';
import { createConsoleLogger, LoggerOptions, loggers } from '@midwayjs/logger';
import * as http from 'http';
import { isDevelopmentEnvironment } from '@midwayjs/core/dist/util';

const LOCK_KEY = '_faas_starter_start_key';

@Framework()
export class MidwayFaaSFramework extends BaseFramework<
  IMidwayFaaSApplication,
  FaaSContext,
  IFaaSConfigurationOptions
> {
  protected defaultHandlerMethod = 'handler';
  protected funMappingStore: Map<string, RouterInfo> = new Map();
  protected logger;
  private lock = new SimpleLock();
  public app: IMidwayFaaSApplication;
  private isReplaceLogger =
    process.env['MIDWAY_SERVERLESS_REPLACE_LOGGER'] === 'true';
  private developmentRun = false;
  private serverlessRoutes = [];
  private server;

  @Inject()
  environmentService: MidwayEnvironmentService;

  @Inject()
  middlewareService: MidwayMiddlewareService<FaaSContext, any>;

  configure(options: IFaaSConfigurationOptions) {
    const faasConfig = this.configService.getConfiguration('faas') ?? {};
    if (options || faasConfig['developmentRun']) {
      this.developmentRun = true;
      this.configurationOptions = options;
    } else {
      return faasConfig;
    }
  }

  isEnable(): boolean {
    return !this.developmentRun;
  }

  async applicationInitialize(options: IMidwayBootstrapOptions) {
    if (!this.logger) {
      this.logger = options.logger || loggers.getLogger('appLogger');
    }
    this.app =
      this.configurationOptions.applicationAdapter?.getApplication() ||
      ({} as IMidwayFaaSApplication);

    this.defineApplicationProperties({
      /**
       * return init context value such as aliyun fc
       */
      getInitializeContext: () => {
        return this.configurationOptions.initializeContext;
      },

      /**
       * @deprecated
       * @param middlewareId
       */
      generateMiddleware: async (middlewareId: any) => {
        return this.generateMiddleware(middlewareId);
      },

      getFunctionName: () => {
        return this.configurationOptions.applicationAdapter?.getFunctionName();
      },

      getFunctionServiceName: () => {
        return this.configurationOptions.applicationAdapter?.getFunctionServiceName();
      },
    });
    // hack use method
    (this.app as any).originUse = this.app.use;
    this.app.use = this.app.useMiddleware as any;
  }

  public async run() {
    return this.lock.sureOnce(async () => {
      // set app keys
      this.app['keys'] = this.configService.getConfiguration('keys') ?? '';

      // store all http function entry
      const collector = new ServerlessTriggerCollector();
      const functionList = await collector.getFunctionList();
      for (const funcInfo of functionList) {
        // store handler
        this.funMappingStore.set(funcInfo.funcHandlerName, funcInfo);
        if (funcInfo.url) {
          // store router
          this.serverlessRoutes.push({
            matchPattern: pathToRegexp(funcInfo.url, [], { end: false }),
            funcInfo: funcInfo,
          });
        }
      }

      if (isDevelopmentEnvironment(this.app.getEnv())) {
        const faasConfig = this.configService.getConfiguration('faas') ?? {};
        this.server = await new Promise(resolve => {
          const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://${req.headers.host}`);
            if (url.pathname) {

            }
            res.end();
          });
          if (faasConfig['port']) {
            server.listen(faasConfig['port']);
          }
          resolve(server);
        });
      }
    }, LOCK_KEY);
  }

  public getFrameworkType(): MidwayFrameworkType {
    return MidwayFrameworkType.FAAS;
  }

  public handleInvokeWrapper(handlerMapping: string) {
    let funOptions: RouterInfo = this.funMappingStore.get(handlerMapping);

    return async (...args) => {
      if (args.length === 0) {
        throw new Error('first parameter must be function context');
      }

      const context: FaaSContext = this.getContext(args.shift());
      const isHttpFunction = !!(context.headers && context.get);

      if (!funOptions && isHttpFunction) {
        for (const item of this.serverlessRoutes) {
          if (item.matchPattern.test(context.path)) {
            funOptions = item.funcInfo;
            break;
          }
        }
      }

      if (!funOptions) {
        throw new Error(`function handler = ${handlerMapping} not found`);
      }

      const globalMiddlewareFn = await this.applyMiddleware();
      const middlewareManager = new ContextMiddlewareManager();

      middlewareManager.insertLast(globalMiddlewareFn);
      middlewareManager.insertLast(async (ctx, next) => {
        const fn = await this.middlewareService.compose(
          [
            ...funOptions.controllerMiddleware,
            ...funOptions.middleware,
            async (ctx, next) => {
              if (isHttpFunction) {
                args = [ctx];
              }
              // invoke handler
              const result = await this.invokeHandler(
                funOptions,
                ctx,
                args,
                isHttpFunction
              );
              if (isHttpFunction && result !== undefined) {
                ctx.body = result;
              }
              return result;
            },
          ],
          this.app
        );
        return await fn(ctx as FaaSContext, next);
      });
      const composeMiddleware = await this.middlewareService.compose(
        middlewareManager,
        this.app
      );

      return await composeMiddleware(context);
    };
  }

  /**
   * @deprecated
   * @param middlewareId
   */
  public async generateMiddleware(
    middlewareId: string
  ): Promise<FunctionMiddleware<FaaSContext, any>> {
    const mwIns: any = await this.getApplicationContext().getAsync(
      middlewareId
    );
    return mwIns.resolve();
  }

  public getContext(context) {
    if (!context.env) {
      context.env = this.environmentService.getCurrentEnvironment();
    }

    if (this.isReplaceLogger || !context.logger) {
      context._serverlessLogger = this.createContextLogger(context);
      /**
       * 由于 fc 的 logger 有 bug，FC公有云环境我们会默认替换掉，其他平台后续视情况而定
       */
      Object.defineProperty(context, 'logger', {
        get() {
          return context._serverlessLogger;
        },
      });
    }
    this.app.createAnonymousContext(context);
    return context;
  }

  private async invokeHandler(
    routerInfo: RouterInfo,
    context,
    args,
    isHttpFunction: boolean
  ) {
    const funModule = await context.requestContext.getAsync(
      routerInfo.controllerId
    );
    const handlerName =
      this.getFunctionHandler(context, args, funModule, routerInfo.method) ||
      this.defaultHandlerMethod;
    if (funModule[handlerName]) {
      // invoke real method
      const result = await funModule[handlerName](...args);
      // implement response decorator
      const routerResponseData = routerInfo.responseMetadata;
      if (isHttpFunction) {
        for (const routerRes of routerResponseData) {
          switch (routerRes.type) {
            case WEB_RESPONSE_HTTP_CODE:
              context.status = routerRes.code;
              break;
            case WEB_RESPONSE_HEADER:
              for (const key in routerRes?.setHeaders || {}) {
                context.set(key, routerRes.setHeaders[key]);
              }
              break;
            case WEB_RESPONSE_CONTENT_TYPE:
              context.type = routerRes.contentType;
              break;
            case WEB_RESPONSE_REDIRECT:
              context.status = routerRes.code;
              context.redirect(routerRes.url);
              return;
          }
        }
      }
      return result;
    }
  }

  protected getFunctionHandler(ctx, args, target, method): string {
    if (method && typeof target[method] !== 'undefined') {
      return method;
    }
    const handlerMethod = this.defaultHandlerMethod;
    if (handlerMethod && typeof target[handlerMethod] !== 'undefined') {
      return handlerMethod;
    }
    throw new Error(
      `no handler setup on ${target.name}#${
        method || this.defaultHandlerMethod
      }`
    );
  }

  public createLogger(name: string, option: LoggerOptions = {}) {
    // 覆盖基类的创建日志对象，函数场景下的日志，即使自定义，也只启用控制台输出
    return createConsoleLogger(name, option);
  }

  public getFrameworkName() {
    return 'midway:faas';
  }
}

export const createModuleServerlessFramework = async (
  globalOption: Omit<IMidwayBootstrapOptions, 'applicationContext'> &
    IFaaSConfigurationOptions
) => {
  const applicationContext = await initializeGlobalApplicationContext({
    ...globalOption,
    baseDir: '',
    appDir: '',
  });
  return applicationContext.get(MidwayFaaSFramework);
};
