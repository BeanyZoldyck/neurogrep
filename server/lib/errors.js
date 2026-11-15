export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// S3 answers 403 for a missing key when the caller cannot ListBucket.
// That is the public bucket's behavior, so 403 and 404 both mean "no object".
export class PublicObjectError extends HttpError {
  constructor(status, message) {
    super(status, message);
    this.name = 'PublicObjectError';
    this.code = status === 403 || status === 404 ? 'NotFound' : 'FetchFailed';
  }
}
