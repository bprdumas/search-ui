import { Logger } from '../misc/Logger';
import { EndpointCaller, IEndpointCallerOptions } from '../rest/EndpointCaller';
import { IAPIAnalyticsVisitResponseRest } from './APIAnalyticsVisitResponse';
import { IErrorResponse } from '../rest/EndpointCaller';
import { IAPIAnalyticsSearchEventsResponse } from '../rest/APIAnalyticsSearchEventsResponse';
import { ISearchEvent } from '../rest/SearchEvent';
import { IClickEvent } from '../rest/ClickEvent';
import { IAPIAnalyticsEventResponse } from './APIAnalyticsEventResponse';
import { Assert } from '../misc/Assert';
import { ICustomEvent } from './CustomEvent';
import { ITopQueries } from './TopQueries';
import { QueryUtils } from '../utils/QueryUtils';
import { Cookie } from '../utils/CookieUtils';
import { ISuccessResponse } from '../rest/EndpointCaller';
import { IStringMap } from '../rest/GenericParam';
import * as _ from 'underscore';

export interface IAnalyticsEndpointOptions {
  token: string;
  serviceUrl: string;
  organization: string;
}

export class AnalyticsEndpoint {
  logger: Logger;

  static DEFAULT_ANALYTICS_URI = 'https://usageanalytics.coveo.com';
  static DEFAULT_ANALYTICS_VERSION = 'v15';
  static CUSTOM_ANALYTICS_VERSION = undefined;
  static VISITOR_COOKIE_TIME = 10000 * 24 * 60 * 60 * 1000;

  static pendingRequest: Promise<any>;

  private visitId: string;
  private organization: string;
  public endpointCaller: EndpointCaller;

  constructor(public options: IAnalyticsEndpointOptions) {
    this.logger = new Logger(this);

    const endpointCallerOptions: IEndpointCallerOptions = {
      accessToken: (this.options.token && this.options.token != '') ? this.options.token : null
    };
    this.endpointCaller = new EndpointCaller(endpointCallerOptions);
    this.organization = options.organization;
  }

  public getCurrentVisitId(): string {
    return this.visitId;
  }

  public getCurrentVisitIdPromise(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.getCurrentVisitId()) {
        resolve(this.getCurrentVisitId());
      } else {
        const url = this.buildAnalyticsUrl('/analytics/visit');
        this.getFromService<IAPIAnalyticsVisitResponseRest>(url, {})
          .then((response: IAPIAnalyticsVisitResponseRest) => {
            this.visitId = response.id;
            resolve(this.visitId);
          })
          .catch((response: IErrorResponse) => {
            reject(response);
          });
      }
    });
  }

  public sendSearchEvents(searchEvents: ISearchEvent[]): Promise<IAPIAnalyticsSearchEventsResponse> {
    if (searchEvents.length > 0) {
      this.logger.info('Logging analytics search events', searchEvents);
      return this.sendToService<ISearchEvent[], IAPIAnalyticsSearchEventsResponse>(searchEvents, 'searches', 'searchEvents');
    }
  }

  public sendDocumentViewEvent(documentViewEvent: IClickEvent): Promise<IAPIAnalyticsEventResponse> {
    Assert.exists(documentViewEvent);
    this.logger.info('Logging analytics document view', documentViewEvent);
    return this.sendToService(documentViewEvent, 'click', 'clickEvent', true);
  }

  public sendCustomEvent(customEvent: ICustomEvent) {
    Assert.exists(customEvent);
    this.logger.info('Logging analytics custom event', customEvent);
    return this.sendToService(customEvent, 'custom', 'customEvent');
  }

  public getTopQueries(params: ITopQueries): Promise<string[]> {
    const url = this.buildAnalyticsUrl('/stats/topQueries');
    return this.getFromService<string[]>(url, params);
  }

  private sendToService<D, R>(data: D, path: string, paramName: string, willCausePageUnload = false): Promise<R> {
    const url = QueryUtils.mergePath(this.options.serviceUrl, '/rest/' + (AnalyticsEndpoint.CUSTOM_ANALYTICS_VERSION || AnalyticsEndpoint.DEFAULT_ANALYTICS_VERSION) + '/analytics/' + path);
    const queryString = [];

    if (this.organization) {
      queryString.push('org=' + this.organization);
    }
    if (Cookie.get('visitorId')) {
      queryString.push('visitor=' + encodeURIComponent(Cookie.get('visitorId')));
    }

    if (willCausePageUnload) {
      this.sendDataBeforeUnload(url, queryString, data);
    } else {
      // We use pendingRequest because we don't want to have 2 request to analytics at the same time.
      // Otherwise the cookie visitId won't be set correctly.
      if (AnalyticsEndpoint.pendingRequest == null) {
        return this.sendUsingEndpointCaller<R>(url, queryString, data);
      } else {
        return AnalyticsEndpoint.pendingRequest.finally(() => {
          return this.sendToService<D, R>(data, path, paramName);
        });
      }
    }
  }

  private sendUsingEndpointCaller<R>(url, queryString, data) {
    AnalyticsEndpoint.pendingRequest = this.endpointCaller.call<R>({
      errorsAsSuccess: false,
      method: 'POST',
      queryString: queryString,
      requestData: data,
      url: url,
      responseType: 'text',
      requestDataType: 'application/json'
    }).then((res: ISuccessResponse<R>) => {
      return this.handleAnalyticsEventResponse(<any>res.data);
    }).finally(() => {
      AnalyticsEndpoint.pendingRequest = null;
    });

    return AnalyticsEndpoint.pendingRequest;
  }

  private getFromService<T>(url: string, params: IStringMap<string>): Promise<T> {
    const paramsToSend = (this.options.token && this.options.token != '') ? _.extend({ 'access_token': this.options.token }, params) : params;
    return this.endpointCaller.call<T>({
      errorsAsSuccess: false,
      method: 'GET',
      queryString: this.options.organization ? ['org=' + encodeURIComponent(this.options.organization)] : [],
      requestData: paramsToSend,
      responseType: 'json',
      url: url
    }).then((res: ISuccessResponse<T>) => {
      return res.data;
    });
  }

  private handleAnalyticsEventResponse(response: IAPIAnalyticsEventResponse | IAPIAnalyticsSearchEventsResponse) {
    let visitId: string;
    let visitorId: string;

    if (response['visitId']) {
      visitId = response['visitId'];
      visitorId = response['visitorId'];
    } else if (response['searchEventResponses']) {
      visitId = (<IAPIAnalyticsEventResponse>_.first(response['searchEventResponses'])).visitId;
      visitorId = (<IAPIAnalyticsEventResponse>_.first(response['searchEventResponses'])).visitorId;
    }

    if (visitId) {
      this.visitId = visitId;
    }
    if (visitorId) {
      Cookie.set('visitorId', visitorId, AnalyticsEndpoint.VISITOR_COOKIE_TIME);
    }

    return response;
  }


  private buildAnalyticsUrl(path: string) {
    return this.options.serviceUrl + '/rest/' + (AnalyticsEndpoint.CUSTOM_ANALYTICS_VERSION || AnalyticsEndpoint.DEFAULT_ANALYTICS_VERSION) + path;
  }

  private sendDataBeforeUnload<D>(url: string, queryString: string[], data: D) {
    if (navigator && navigator.sendBeacon) {
      this.sendDataBeforeUnloadUsingBeacon(url, queryString, data);
    } else {
      this.sendDataBeforeUnloadUsingHack(url, queryString, data);
    }
  }

  private sendDataBeforeUnloadUsingBeacon<D>(url: string, queryString: string[], data: D) {
    const headers = {
      type: 'application/json'
    };
    const blob = new Blob([JSON.stringify(data)], headers);
    // sendBeacon only support a 'type' attribute in the header.
    // it does not support authorization header
    // it needs to be added in the query string ...
    navigator.sendBeacon(this.endpointCaller.combineUrlAndQueryString(url, queryString.concat([`access_token=${this.options.token}`])), blob);
  }

  private sendDataBeforeUnloadUsingHack<D>(url: string, queryString: string[], data: D) {
    const img = new Image();
    this.sendUsingEndpointCaller(url, queryString, data);
    
    window.addEventListener('beforeunload', () => {
      img.src = 'https://static.cloud.coveo.com/searchui/v1.2537/image/spritesNew.png';
    });
  }
}
