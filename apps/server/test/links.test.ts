import { describe, expect, it } from 'vitest'
import { linkDatabaseName, linkUrl } from '@vercio/shared'
import {
  declaredPort,
  linkKind,
  provisionStatements,
  randomPassword,
} from '../src/networks/links.js'

describe('Liaisons entre projets', () => {
  it('reconnaît le type de service d’après son image', () => {
    expect(linkKind('postgres:17')).toBe('postgres')
    expect(linkKind('bitnami/postgresql:16')).toBe('postgres')
    expect(linkKind('mariadb:11')).toBe('mariadb')
    expect(linkKind('mongo:7')).toBe('mongo')
    expect(linkKind('redis:7-alpine')).toBe('redis')
    expect(linkKind('valkey/valkey:8')).toBe('redis')
    expect(linkKind('kong:3.6')).toBe('service')
    expect(linkKind(null)).toBe('service')
  })

  it('trouve le port d’un service quelconque dans son fichier Compose', () => {
    expect(declaredPort(['8000:8000'])).toBe(8000)
    expect(declaredPort(['127.0.0.1:8080:3000/tcp'])).toBe(3000)
    expect(declaredPort(['9000'])).toBe(9000)
    expect(declaredPort([])).toBeNull()
  })

  it('construit l’adresse de connexion selon le type', () => {
    const creds = { user: 'planny', password: 'abc', database: 'planny' }
    expect(linkUrl('postgres', 'postgres', 5432, creds)).toBe(
      'postgresql://planny:abc@postgres:5432/planny',
    )
    expect(linkUrl('mysql', 'db', 3306, creds)).toBe('mysql://planny:abc@db:3306/planny')
    expect(linkUrl('mongo', 'mongo', 27017, creds)).toBe(
      'mongodb://planny:abc@mongo:27017/planny?authSource=planny',
    )
    expect(linkUrl('redis', 'cache', 6379)).toBe('redis://cache:6379')
    expect(linkUrl('service', 'gateway', 8000)).toBe('http://gateway:8000')
  })

  it('propose un nom de base valide pour chaque projet', () => {
    expect(linkDatabaseName('planny')).toBe('planny')
    expect(linkDatabaseName('skill-in')).toBe('skill_in')
    expect(linkDatabaseName('2048-jeu')).toBe('app_2048_jeu')
  })

  it('génère des instructions idempotentes, sans caractère à échapper', () => {
    const password = randomPassword()
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/)
    const mysql = provisionStatements('mariadb', 'planny', password)
    expect(mysql).toContain('CREATE DATABASE IF NOT EXISTS `planny`')
    expect(mysql).toContain("GRANT ALL PRIVILEGES ON `planny`.* TO 'planny'@'%'")
    expect(provisionStatements('mongo', 'planny', password)).toContain(
      "role: 'readWrite', db: 'planny'",
    )
  })
})
