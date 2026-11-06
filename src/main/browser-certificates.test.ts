import assert from 'node:assert/strict'
import test from 'node:test'
import { CertificateExceptions, certificateCanProceed, certificateHost, certificateProblem } from './browser-certificates.js'

const failure = { host: 'dev.example', error: 'ERR_CERT_COMMON_NAME_INVALID', fingerprint: 'sha256/one' }

test('only TLS addresses have a certificate host', () => {
  assert.equal(certificateHost('https://DEV.example:8443/path?q=1'), 'dev.example')
  assert.equal(certificateHost('wss://dev.example/socket'), 'dev.example')
  assert.equal(certificateHost('http://dev.example/'), null)
  assert.equal(certificateHost('file:///C:/secret'), null)
  assert.equal(certificateHost('not a url'), null)
})

test('nothing is allowed until the user proceeds', () => {
  const exceptions = new CertificateExceptions()
  assert.equal(exceptions.allows('https://dev.example/', failure.error, failure.fingerprint), false)
  assert.equal(exceptions.coversHost('https://dev.example/'), false)
})

test('an exception covers its host on any port or path, including sockets', () => {
  const exceptions = new CertificateExceptions()
  exceptions.add(failure)
  assert.equal(exceptions.allows('https://dev.example/', failure.error, failure.fingerprint), true)
  assert.equal(exceptions.allows('https://dev.example:8443/other', failure.error, failure.fingerprint), true)
  assert.equal(exceptions.allows('wss://dev.example/socket', failure.error, failure.fingerprint), true)
  assert.equal(exceptions.coversHost('https://dev.example/other'), true)
})

test('another host, certificate or error warns again', () => {
  const exceptions = new CertificateExceptions()
  exceptions.add(failure)
  assert.equal(exceptions.allows('https://other.example/', failure.error, failure.fingerprint), false)
  assert.equal(exceptions.allows('https://sub.dev.example/', failure.error, failure.fingerprint), false)
  assert.equal(exceptions.allows('https://dev.example/', failure.error, 'sha256/two'), false)
  assert.equal(exceptions.allows('https://dev.example/', 'ERR_CERT_DATE_INVALID', failure.fingerprint), false)
  assert.equal(exceptions.coversHost('https://other.example/'), false)
})

test('a certificate without a fingerprint is never allowed', () => {
  const exceptions = new CertificateExceptions()
  exceptions.add({ ...failure, fingerprint: '' })
  assert.equal(exceptions.allows('https://dev.example/', failure.error, ''), false)
})

test('only errors a person can judge can be proceeded past', () => {
  for (const error of ['ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID']) assert.equal(certificateCanProceed(error), true, error)
  for (const error of ['ERR_CERT_REVOKED', 'ERR_CERT_INVALID', 'ERR_CERT_CONTAINS_ERRORS', 'ERR_CERT_SOMETHING_NEW', '']) assert.equal(certificateCanProceed(error), false, error)
})

test('an error that cannot be proceeded past never becomes an exception', () => {
  const exceptions = new CertificateExceptions()
  exceptions.add({ ...failure, error: 'ERR_CERT_REVOKED' })
  assert.equal(exceptions.allows('https://dev.example/', 'ERR_CERT_REVOKED', failure.fingerprint), false)
  assert.equal(exceptions.coversHost('https://dev.example/'), false, 'the host is not marked as proceeded past')
})

test('the warning explains common errors and has a fallback', () => {
  assert.match(certificateProblem('ERR_CERT_COMMON_NAME_INVALID', 'dev.example'), /not valid for dev\.example/)
  assert.match(certificateProblem('ERR_CERT_DATE_INVALID', 'dev.example'), /expired/)
  assert.match(certificateProblem('ERR_CERT_AUTHORITY_INVALID', 'dev.example'), /authority/)
  assert.match(certificateProblem('ERR_CERT_REVOKED', 'dev.example'), /revoked/)
  assert.match(certificateProblem('ERR_CERT_INVALID', 'dev.example'), /could not be verified/)
})
