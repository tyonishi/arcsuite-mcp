/** Java owns ArcSuite session refresh and the single bounded business-read retry. */
export class AdapterSessionManager {
  executeRead<T>(_clientProfileId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
