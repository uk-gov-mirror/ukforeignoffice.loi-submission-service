import { Op } from 'sequelize'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../server/config/config.js'
import { logger } from '../server/config/logs.js'
import { checkForAdditionalPayments } from '../server/controllers/pollForAdditionalPaymentsController.js'
import { AdditionalPaymentDetails, sequelize } from '../server/models/index.js'

describe('pollForAdditionalPaymentsController.checkForAdditionalPayments', () => {
  let loggerErrorStub

  beforeEach(() => {
    loggerErrorStub = vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('queries for queued records and exits when none found', async () => {
    const findOneStub = vi.spyOn(AdditionalPaymentDetails, 'findOne').mockResolvedValue(null)
    const updateStub = vi.spyOn(AdditionalPaymentDetails, 'update').mockResolvedValue(undefined)

    await checkForAdditionalPayments()

    expect(findOneStub).toHaveBeenCalledOnce()
    expect(findOneStub).toHaveBeenCalledWith({
      where: {
        submitted: 'queued',
        submission_attempts: {
          [Op.lte]: config.maxRetryAttempts,
        },
      },
      order: sequelize.random(),
    })
    expect(updateStub).not.toHaveBeenCalled()
  })

  it('handles errors in eligibility lookup without throwing', async () => {
    const expectedError = new Error('database unavailable')
    vi.spyOn(AdditionalPaymentDetails, 'findOne').mockRejectedValue(expectedError)

    await checkForAdditionalPayments()

    expect(loggerErrorStub).toHaveBeenCalledOnce()
    expect(loggerErrorStub).toHaveBeenCalledWith('Error checking for eligible additional payments', {
      error: expectedError,
    })
  })
})
