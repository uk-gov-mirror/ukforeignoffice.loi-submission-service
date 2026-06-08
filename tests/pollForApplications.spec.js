import { Op } from 'sequelize'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../server/config/logs.js'
import {
  checkForEligibleApplications,
  placeBackInTheQueue,
  updateApplicationAsProcessing,
} from '../server/controllers/pollForApplicationsController.js'
import { Application, sequelize } from '../server/models/index.js'

const maxRetryAttempts = 10

let loggerInfoStub
let loggerErrorStub

describe('checkForEligibleApplications', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should return an eligible application when available', async () => {
    const mockApplication = {
      id: 12345,
      submitted: 'queued',
      submissionAttempts: 0,
    }

    const findOneStub = vi.spyOn(Application, 'findOne').mockResolvedValue(mockApplication)

    const result = await checkForEligibleApplications()

    expect(result).toEqual(mockApplication)
    expect(findOneStub).toHaveBeenCalledOnce()
    expect(findOneStub).toHaveBeenCalledWith({
      where: {
        submitted: 'queued',
        submissionAttempts: {
          [Op.lt]: maxRetryAttempts,
        },
      },
      order: sequelize.random(),
    })
  })

  it('should handle errors gracefully', async () => {
    vi.spyOn(Application, 'findOne').mockRejectedValue(new Error('CRITICAL ERROR TESTING'))

    const result = await checkForEligibleApplications()

    expect(result).toBeUndefined()
  })
})

describe('isEApp', () => {
  it('should be true when service_type is 4', () => {
    const service_type = 4

    const isEApp = service_type === 4

    expect(isEApp).toBe(true)
  })

  it('should be false when service_type is not 4', () => {
    const service_type = 1

    const isEApp = service_type === 4

    expect(isEApp).toBe(false)
  })
})

describe('updateApplicationAsProcessing', () => {
  beforeEach(() => {
    loggerInfoStub = vi.spyOn(logger, 'info').mockImplementation(() => {})
    loggerErrorStub = vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should update the application as processing when isEApp is true', async () => {
    const application_id = 12345
    const isEApp = true

    const updateStub = vi.spyOn(Application, 'update').mockResolvedValue([1])

    const result = await updateApplicationAsProcessing(application_id, isEApp)

    expect(result).toEqual([1])
    expect(updateStub).toHaveBeenCalledOnce()
    expect(updateStub).toHaveBeenCalledWith({ submitted: 'processing' }, { where: { application_id: application_id } })
    expect(loggerInfoStub).toHaveBeenCalledOnce()
    expect(loggerInfoStub).toHaveBeenCalledWith(`Processing ${application_id} (eApp)`, {
      application_id: 12345,
      isEApp: true,
    })
  })

  it('should update the application as processing when isEApp is false', async () => {
    const application_id = 67890
    const isEApp = false

    const updateStub = vi.spyOn(Application, 'update').mockResolvedValue([1])

    const result = await updateApplicationAsProcessing(application_id, isEApp)

    expect(result).toEqual([1])
    expect(updateStub).toHaveBeenCalledOnce()
    expect(updateStub).toHaveBeenCalledWith({ submitted: 'processing' }, { where: { application_id: application_id } })
    expect(loggerInfoStub).toHaveBeenCalledOnce()
    expect(loggerInfoStub).toHaveBeenCalledWith(`Processing ${application_id} (paper)`, {
      application_id: 67890,
      isEApp: false,
    })
  })

  it('should handle errors gracefully', async () => {
    const application_id = 12345
    const isEApp = true

    const errorMessage = 'Some error message'
    const updateStub = vi.spyOn(Application, 'update').mockRejectedValue(new Error(errorMessage))

    const result = await updateApplicationAsProcessing(application_id, isEApp)

    expect(result).toBeUndefined()
    expect(updateStub).toHaveBeenCalledOnce()
    expect(updateStub).toHaveBeenCalledWith({ submitted: 'processing' }, { where: { application_id: application_id } })
    expect(loggerInfoStub).toHaveBeenCalledOnce()
    expect(loggerErrorStub).toHaveBeenCalledOnce()
    expect(loggerErrorStub).toHaveBeenCalledWith(`Error in updateApplicationAsProcessing for ${application_id}`, {
      application_id,
      error: new Error(errorMessage),
    })
  })
})

describe('placeBackInTheQueue', () => {
  beforeEach(() => {
    loggerInfoStub = vi.spyOn(logger, 'info').mockImplementation(() => {})
    loggerErrorStub = vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should update the application and set it back to "queued"', async () => {
    const application_id = 12345
    const submission_attempts = 5

    const updateStub = vi.spyOn(Application, 'update').mockResolvedValue([1])

    const result = await placeBackInTheQueue(application_id, submission_attempts)

    expect(result).toEqual([1])
    expect(updateStub).toHaveBeenCalledOnce()
    expect(updateStub).toHaveBeenCalledWith(
      {
        submissionAttempts: submission_attempts,
        submitted: 'queued',
      },
      { where: { application_id: application_id } },
    )
    expect(loggerInfoStub).toHaveBeenCalledOnce()
    expect(loggerInfoStub).toHaveBeenCalledWith(
      `Updating ${application_id} submission attempts (${submission_attempts}/${maxRetryAttempts})`,
      { application_id, maxRetryAttempts, submission_attempts },
    )
  })

  it('should handle errors gracefully', async () => {
    const application_id = 12345
    const submission_attempts = 5

    const errorMessage = 'Some error message'
    const updateStub = vi.spyOn(Application, 'update').mockRejectedValue(new Error(errorMessage))

    const result = await placeBackInTheQueue(application_id, submission_attempts)

    expect(result).toBeUndefined()
    expect(updateStub).toHaveBeenCalledOnce()
    expect(updateStub).toHaveBeenCalledWith(
      {
        submissionAttempts: submission_attempts,
        submitted: 'queued',
      },
      { where: { application_id: application_id } },
    )
    expect(loggerErrorStub).toHaveBeenCalledOnce()
    expect(loggerErrorStub).toHaveBeenCalledWith(`Error in placeBackInTheQueue for ${application_id}`, {
      application_id,
      error: new Error(errorMessage),
    })
  })
})
